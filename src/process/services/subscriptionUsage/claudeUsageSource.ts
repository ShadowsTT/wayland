/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Claude Code subscription usage source.
 *
 * The ACP stream does NOT carry rate-limit windows, so we fetch them fresh from
 * Anthropic's UNDOCUMENTED OAuth usage endpoint using the subscription access
 * token already stored by the "Sign in with Claude" flow
 * (`~/.claude/.credentials.json`, read via `readClaudeCredentialsFile`).
 *
 * ============================ ENDPOINT ASSUMPTIONS ============================
 * Everything below is undocumented and may drift. It is deliberately isolated
 * here (constants + `parseClaudeUsage`) so a shape change is a one-file fix:
 *
 *   - URL:     https://api.anthropic.com/api/oauth/usage
 *   - Headers: Authorization: Bearer <accessToken>
 *              anthropic-beta: oauth-2025-04-20   (repo convention, see
 *                              claudeSubscriptionModels.ts)
 *              anthropic-version: 2023-06-01
 *   - Body:    an object with a ~5h window and a ~7d window, each carrying a
 *              utilization percentage + a reset timestamp. Field NAMES are
 *              unknown, so `parseClaudeUsage` accepts many synonyms (snake_case
 *              and camelCase) and tolerates missing fields.
 *
 * On ANY failure (no creds, non-200, parse failure) we return
 * `{ provider:'claude', available:false }` and never throw.
 * =============================================================================
 */

import { readClaudeCredentialsFile } from '@process/onboarding/claudeCredentialsFile';
import type { ProviderUsage, UsageWindow } from './types';

const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';
const ANTHROPIC_VERSION = '2023-06-01';
const FETCH_TIMEOUT_MS = 12_000;

// Candidate keys for locating each window node inside the response object.
// Ordered most→least likely; first hit wins. Add synonyms here if the shape
// changes rather than touching the extraction logic.
const FIVE_HOUR_KEYS = ['five_hour', 'fiveHour', 'session', 'five_hour_limit', '5h'] as const;
const WEEKLY_KEYS = ['seven_day', 'sevenDay', 'weekly', 'week', 'seven_day_limit', '7d'] as const;
const WEEKLY_SONNET_KEYS = ['seven_day_sonnet', 'sevenDaySonnet', 'weekly_sonnet', 'seven_day_oauth_sonnet'] as const;

// Candidate field names inside a window node.
const PERCENT_KEYS = ['utilization', 'used_percent', 'usedPercent', 'percent_used', 'percentUsed', 'percent'] as const;
const RESET_KEYS = ['resets_at', 'resetsAt', 'reset_at', 'resetAt', 'reset', 'resets'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function toFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Coerce a reset value (epoch seconds, epoch ms, or ISO string) to epoch ms. */
function toEpochMs(v: unknown): number | undefined {
  const n = toFiniteNumber(v);
  if (n !== undefined) {
    // Values below ~year 2001 in ms are almost certainly seconds.
    return n < 1e12 ? n * 1000 : n;
  }
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstBy<T>(
  node: Record<string, unknown>,
  keys: readonly string[],
  pick: (v: unknown) => T | undefined
): T | undefined {
  for (const key of keys) {
    if (key in node) {
      const got = pick(node[key]);
      if (got !== undefined) return got;
    }
  }
  return undefined;
}

/** Extract a `UsageWindow` from a candidate node, or undefined if no percent. */
function extractWindow(node: unknown): UsageWindow | undefined {
  if (!isRecord(node)) return undefined;
  const usedPercent = firstBy(node, PERCENT_KEYS, toFiniteNumber);
  if (usedPercent === undefined) return undefined;
  const resetsAt = firstBy(node, RESET_KEYS, toEpochMs) ?? 0;
  return { usedPercent, resetsAt };
}

function pickNode(root: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (key in root) return root[key];
  }
  return undefined;
}

/**
 * Pure, testable parse of the OAuth usage response into a `ProviderUsage`.
 * Never throws; returns `available:false` when nothing usable is found.
 */
export function parseClaudeUsage(json: unknown): ProviderUsage {
  if (!isRecord(json)) return { provider: 'claude', available: false };

  const fiveHour = extractWindow(pickNode(json, FIVE_HOUR_KEYS));
  const weekly = extractWindow(pickNode(json, WEEKLY_KEYS));
  const weeklySonnet = extractWindow(pickNode(json, WEEKLY_SONNET_KEYS));

  if (!fiveHour && !weekly && !weeklySonnet) {
    return { provider: 'claude', available: false };
  }

  const result: ProviderUsage = { provider: 'claude', available: true };
  if (fiveHour) result.fiveHour = fiveHour;
  if (weekly) result.weekly = weekly;
  if (weeklySonnet) result.weeklySonnet = weeklySonnet;
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the subscription token, hit the undocumented usage endpoint, and parse
 * the result. Never throws - returns `available:false` on any failure.
 */
export async function fetchClaudeUsage(): Promise<ProviderUsage> {
  try {
    const tokens = await readClaudeCredentialsFile();
    if (!tokens || tokens.accessToken.length === 0) {
      return { provider: 'claude', available: false };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(CLAUDE_USAGE_ENDPOINT, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${tokens.accessToken}`,
          'anthropic-beta': ANTHROPIC_OAUTH_BETA,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      return { provider: 'claude', available: false, error: `HTTP ${res.status}` };
    }
    const json = (await res.json()) as unknown;
    return parseClaudeUsage(json);
  } catch (error) {
    return { provider: 'claude', available: false, error: errorMessage(error) };
  }
}
