/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Codex CLI subscription usage source - fully LOCAL, no API.
 *
 * Codex writes session rollouts to
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, one JSON object per line. The
 * newest file that contains a `token_count` event carries the current
 * rate-limit state in its LAST such event:
 *
 *   rate_limits.primary   = ~5h window  { used_percent, window_minutes, resets_in_seconds }
 *   rate_limits.secondary = ~7d window  { used_percent, window_minutes, resets_in_seconds }
 *
 * `resets_in_seconds` is relative to when the line was written, which we
 * approximate with the file's mtime: resetsAt = mtimeMs + resets_in_seconds*1000.
 *
 * On any failure returns `{ provider:'codex', available:false }`; never throws.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProviderUsage, UsageWindow } from './types';

const SESSIONS_LOOKBACK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function toFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Recursively locate a `rate_limits` object carrying primary/secondary. Bounded depth. */
function findRateLimits(node: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 6 || !isRecord(node)) return undefined;
  const direct = node.rate_limits ?? node.rateLimits;
  if (isRecord(direct) && (isRecord(direct.primary) || isRecord(direct.secondary))) {
    return direct;
  }
  for (const value of Object.values(node)) {
    const found = findRateLimits(value, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Map one `rate_limits.{primary,secondary}` node to a `UsageWindow`. */
function codexWindow(node: unknown, mtimeMs: number): UsageWindow | undefined {
  if (!isRecord(node)) return undefined;
  const usedPercent = toFiniteNumber(node.used_percent) ?? toFiniteNumber(node.usedPercent);
  if (usedPercent === undefined) return undefined;
  const resetsInSeconds = toFiniteNumber(node.resets_in_seconds) ?? toFiniteNumber(node.resetsInSeconds);
  const resetsAt = resetsInSeconds !== undefined ? mtimeMs + resetsInSeconds * 1000 : 0;
  return { usedPercent, resetsAt };
}

/**
 * Pure, testable parse of a session JSONL string. Uses the LAST `token_count`
 * (rate_limits) event and the supplied file mtime to compute reset times.
 * Never throws.
 */
export function parseCodexRateLimits(jsonlText: string, fileMtimeMs: number): ProviderUsage {
  let latest: Record<string, unknown> | undefined;
  for (const line of jsonlText.split(/\r?\n/)) {
    const trimmed = line.trim();
    // Cheap pre-filter: only lines mentioning rate limits can matter.
    if (trimmed.length === 0 || !trimmed.includes('rate_limits')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const found = findRateLimits(parsed);
    if (found) latest = found; // keep the LAST match
  }

  if (!latest) return { provider: 'codex', available: false };

  const fiveHour = codexWindow(latest.primary, fileMtimeMs);
  const weekly = codexWindow(latest.secondary, fileMtimeMs);
  if (!fiveHour && !weekly) return { provider: 'codex', available: false };

  const result: ProviderUsage = { provider: 'codex', available: true };
  if (fiveHour) result.fiveHour = fiveHour;
  if (weekly) result.weekly = weekly;
  return result;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Collect rollout-*.jsonl candidate paths for the last N days, newest dirs first. */
async function collectRolloutFiles(homeDir: string): Promise<string[]> {
  const base = path.join(homeDir, '.codex', 'sessions');
  const files: string[] = [];
  const now = Date.now();
  for (let i = 0; i < SESSIONS_LOOKBACK_DAYS; i++) {
    const day = new Date(now - i * DAY_MS);
    const dir = path.join(base, String(day.getFullYear()), pad2(day.getMonth() + 1), pad2(day.getDate()));
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue; // missing day dir
    }
    for (const name of entries) {
      if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
        files.push(path.join(dir, name));
      }
    }
  }
  return files;
}

/**
 * Find the newest rollout file that actually contains a `token_count` event,
 * returning its text + mtime so the caller need not re-read it.
 */
async function findLatestCodexRollout(homeDir: string): Promise<{ text: string; mtimeMs: number } | undefined> {
  const files = await collectRolloutFiles(homeDir);
  const stated = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, mtimeMs: (await fs.stat(file)).mtimeMs };
      } catch {
        return undefined;
      }
    })
  );
  const ordered = stated
    .filter((s): s is { file: string; mtimeMs: number } => s !== undefined)
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { file, mtimeMs } of ordered) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf-8');
    } catch {
      continue;
    }
    if (text.includes('token_count')) {
      return { text, mtimeMs };
    }
  }
  return undefined;
}

/**
 * Read the newest Codex session with usage data and parse it. Never throws -
 * returns `available:false` on any failure.
 */
export async function fetchCodexUsage(homeDir: string = os.homedir()): Promise<ProviderUsage> {
  try {
    const found = await findLatestCodexRollout(homeDir);
    if (!found) return { provider: 'codex', available: false };
    return parseCodexRateLimits(found.text, found.mtimeMs);
  } catch (error) {
    return { provider: 'codex', available: false, error: error instanceof Error ? error.message : String(error) };
  }
}
