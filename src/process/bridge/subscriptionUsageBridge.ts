/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Subscription usage bridge - exposes the Claude + Codex rate-limit snapshot to
 * the renderer (Mission Control usage tab + sidebar badge). Mirrors costBridge:
 * a one-shot read provider backed by a main-process poller, plus an emitter the
 * poller drives on every refresh.
 *
 * Remote (paired-device WebSocket) callers are blocked from
 * `subscriptionUsage.*` by the matching prefix in bridgeAllowlist.ts - quota
 * utilization is account-sensitive, local-renderer-only.
 */

import { ipcBridge } from '@/common';
import type { UsagePoller } from '@process/services/subscriptionUsage/UsagePoller';
import type { UsageSnapshot } from '@process/services/subscriptionUsage/types';

const EMPTY_SNAPSHOT: UsageSnapshot = { providers: [], fetchedAt: 0 };

export function initSubscriptionUsageBridge(poller: UsagePoller): void {
  ipcBridge.subscriptionUsage.snapshot.provider(async ({ force }: { force?: boolean } = {}): Promise<UsageSnapshot> => {
    try {
      return await poller.getSnapshot(force);
    } catch (error) {
      console.error('[subscriptionUsageBridge] snapshot error:', error);
      return EMPTY_SNAPSHOT;
    }
  });

  poller.onChange((snapshot) => ipcBridge.subscriptionUsage.changed.emit(snapshot));
  poller.start();
}
