/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseClaudeUsage } from '@process/services/subscriptionUsage/claudeUsageSource';
import { parseCodexRateLimits } from '@process/services/subscriptionUsage/codexUsageSource';

describe('parseCodexRateLimits', () => {
  const MTIME = 1_700_000_000_000; // fixed epoch ms

  it('extracts primary (5h) + secondary (weekly) and computes resetsAt from mtime', () => {
    const line = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 42.5, window_minutes: 299, resets_in_seconds: 3600 },
          secondary: { used_percent: 12, window_minutes: 10079, resets_in_seconds: 86400 },
        },
      },
    });
    const jsonl = `{"type":"session_meta"}\n${line}\n`;

    const result = parseCodexRateLimits(jsonl, MTIME);

    expect(result.available).toBe(true);
    expect(result.fiveHour).toEqual({ usedPercent: 42.5, resetsAt: MTIME + 3600 * 1000 });
    expect(result.weekly).toEqual({ usedPercent: 12, resetsAt: MTIME + 86400 * 1000 });
  });

  it('uses the LAST token_count event when several are present', () => {
    const first = JSON.stringify({
      payload: { rate_limits: { primary: { used_percent: 10, resets_in_seconds: 60 } } },
    });
    const last = JSON.stringify({
      payload: { rate_limits: { primary: { used_percent: 88, resets_in_seconds: 120 } } },
    });
    const result = parseCodexRateLimits(`${first}\n${last}\n`, MTIME);
    expect(result.fiveHour?.usedPercent).toBe(88);
    expect(result.fiveHour?.resetsAt).toBe(MTIME + 120 * 1000);
  });

  it('returns available:false for empty / garbage input', () => {
    expect(parseCodexRateLimits('', MTIME).available).toBe(false);
    expect(parseCodexRateLimits('not json\n{oops', MTIME).available).toBe(false);
    expect(parseCodexRateLimits('{"payload":{"type":"other"}}', MTIME).available).toBe(false);
  });
});

describe('parseClaudeUsage', () => {
  it('maps 5-hour + weekly windows from the OAuth usage response', () => {
    const json = {
      five_hour: { utilization: 55, resets_at: '2026-07-17T12:00:00.000Z' },
      seven_day: { utilization: 30, resets_at: 1_800_000_000 }, // epoch seconds
      seven_day_sonnet: { utilization: 18, resets_at: 1_800_000_000 },
    };

    const result = parseClaudeUsage(json);

    expect(result.provider).toBe('claude');
    expect(result.available).toBe(true);
    expect(result.fiveHour).toEqual({ usedPercent: 55, resetsAt: Date.parse('2026-07-17T12:00:00.000Z') });
    expect(result.weekly).toEqual({ usedPercent: 30, resetsAt: 1_800_000_000 * 1000 });
    expect(result.weeklySonnet?.usedPercent).toBe(18);
  });

  it('accepts camelCase synonyms', () => {
    const json = { fiveHour: { usedPercent: 5, resetsAt: 1_800_000_000_000 }, weekly: { percent: 9 } };
    const result = parseClaudeUsage(json);
    expect(result.available).toBe(true);
    expect(result.fiveHour).toEqual({ usedPercent: 5, resetsAt: 1_800_000_000_000 });
    expect(result.weekly).toEqual({ usedPercent: 9, resetsAt: 0 });
  });

  it('returns available:false for garbage / empty responses', () => {
    expect(parseClaudeUsage(null).available).toBe(false);
    expect(parseClaudeUsage({}).available).toBe(false);
    expect(parseClaudeUsage('nope').available).toBe(false);
    expect(parseClaudeUsage({ five_hour: { something: 1 } }).available).toBe(false);
  });
});
