/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Subscription usage tracking (Claude Code + Codex CLI rate-limit windows).
 *
 * Distinct from `src/process/services/usage/` (Launchpad telemetry) - this
 * models the 5-hour + weekly rolling quota windows a subscription exposes, not
 * UI-interaction events. The renderer imports these types directly, mirroring
 * how the cost tab imports `@process/services/cost/types`.
 */

/** A single rolling quota window. `resetsAt` is epoch ms (0 = unknown). */
export type UsageWindow = {
  usedPercent: number;
  resetsAt: number;
};

export type SubscriptionProvider = 'claude' | 'codex';

/**
 * One provider's usage read. `available:false` is the honest "no data" state
 * (not signed in / CLI never run / endpoint failed) - never an error banner.
 */
export type ProviderUsage = {
  provider: SubscriptionProvider;
  available: boolean;
  /** ~5-hour rolling window. */
  fiveHour?: UsageWindow;
  /** ~7-day rolling window. */
  weekly?: UsageWindow;
  /** Claude only: Sonnet-specific weekly figure, when the endpoint reports it. */
  weeklySonnet?: UsageWindow;
  /** Best-effort diagnostic; never shown as a hard error to the user. */
  error?: string;
};

export type UsageSnapshot = {
  providers: ProviderUsage[];
  /** Epoch ms the snapshot was assembled (0 = never fetched). */
  fetchedAt: number;
};
