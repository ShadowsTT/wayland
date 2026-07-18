/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Polls both subscription usage sources (Claude + Codex) in parallel, caches
 * the last snapshot, and refreshes on a ~5-minute interval AND on demand. Each
 * source already swallows its own failures, but `Promise.allSettled` guards
 * against an unexpected throw so one bad source never sinks the other.
 */

import { fetchClaudeUsage } from './claudeUsageSource';
import { fetchCodexUsage } from './codexUsageSource';
import type { ProviderUsage, SubscriptionProvider, UsageSnapshot } from './types';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

type UsageSources = {
  fetchClaude: () => Promise<ProviderUsage>;
  fetchCodex: () => Promise<ProviderUsage>;
  intervalMs?: number;
};

type ChangeListener = (snapshot: UsageSnapshot) => void;

function unavailable(provider: SubscriptionProvider, error: unknown): ProviderUsage {
  return { provider, available: false, error: error instanceof Error ? error.message : String(error) };
}

export class UsagePoller {
  private snapshot: UsageSnapshot = { providers: [], fetchedAt: 0 };
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<UsageSnapshot> | undefined;
  private readonly listeners = new Set<ChangeListener>();
  private readonly sources: Required<UsageSources>;

  constructor(sources: UsageSources = { fetchClaude: fetchClaudeUsage, fetchCodex: fetchCodexUsage }) {
    this.sources = {
      fetchClaude: sources.fetchClaude,
      fetchCodex: sources.fetchCodex,
      intervalMs: sources.intervalMs ?? DEFAULT_INTERVAL_MS,
    };
  }

  /** Subscribe to post-refresh snapshots. Returns an unsubscribe function. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start the background refresh loop (idempotent). Kicks an immediate refresh. */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.sources.intervalMs);
    // Do not keep the event loop alive for a background poller.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Return the cached snapshot, or refresh first when forced / never fetched. */
  async getSnapshot(force = false): Promise<UsageSnapshot> {
    if (!force && this.snapshot.fetchedAt > 0) return this.snapshot;
    return this.refresh();
  }

  /** Fetch both sources; dedupes concurrent callers onto one in-flight run. */
  async refresh(): Promise<UsageSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async run(): Promise<UsageSnapshot> {
    const [claude, codex] = await Promise.allSettled([this.sources.fetchClaude(), this.sources.fetchCodex()]);
    const providers: ProviderUsage[] = [
      claude.status === 'fulfilled' ? claude.value : unavailable('claude', claude.reason),
      codex.status === 'fulfilled' ? codex.value : unavailable('codex', codex.reason),
    ];
    const snapshot: UsageSnapshot = { providers, fetchedAt: Date.now() };
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A bad listener must not break the poll loop.
      }
    }
    return snapshot;
  }
}
