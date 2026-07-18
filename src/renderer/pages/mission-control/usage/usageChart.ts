/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure presentation helpers shared by the usage tab, its provider cards, and the
 * sidebar badge: severity tiers, the highest current utilization, and a human
 * reset countdown. Kept framework-free so they stay trivially testable.
 */

import type { BudgetSeverity } from '../cost/costChart';
import type { ProviderUsage, UsageSnapshot, UsageWindow } from '@process/services/subscriptionUsage/types';

const WARN_PERCENT = 70;
const OVER_PERCENT = 90;

/** Green (<70) → amber (70-90) → red (>90), reusing the cost bar's tiers. */
export function severityForPercent(percent: number): BudgetSeverity {
  if (percent > OVER_PERCENT) return 'over';
  if (percent >= WARN_PERCENT) return 'warn';
  return 'ok';
}

/** Every window carried by one provider (for max/among iteration). */
export function windowsOf(provider: ProviderUsage): UsageWindow[] {
  const windows: UsageWindow[] = [];
  if (provider.fiveHour) windows.push(provider.fiveHour);
  if (provider.weekly) windows.push(provider.weekly);
  if (provider.weeklySonnet) windows.push(provider.weeklySonnet);
  return windows;
}

/**
 * Highest utilization across every window of every available provider, or -1
 * when there is nothing to show (so the sidebar can render nothing).
 */
export function maxUsagePercent(snapshot: UsageSnapshot): number {
  let max = -1;
  for (const provider of snapshot.providers) {
    if (!provider.available) continue;
    for (const window of windowsOf(provider)) {
      if (window.usedPercent > max) max = window.usedPercent;
    }
  }
  return max;
}

/**
 * A compact "2h 14m" / "14m" / "<1m" string for time remaining until reset, or
 * '' when the reset time is unknown or already past.
 */
export function formatResetCountdown(resetsAt: number, now: number = Date.now()): string {
  if (!Number.isFinite(resetsAt) || resetsAt <= now) return '';
  const totalMinutes = Math.floor((resetsAt - now) / 60_000);
  if (totalMinutes < 1) return '<1m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
