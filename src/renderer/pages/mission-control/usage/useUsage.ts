/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Loads the subscription usage snapshot (Claude + Codex 5h/weekly windows) for
 * the Mission Control usage tab and sidebar badge. Fetches once on mount, then
 * lives off the main-process `subscriptionUsage.changed` push so the poller's
 * ~5-minute refresh flows in without re-invoking.
 */

import { useCallback, useEffect, useState } from 'react';
import { ipcBridge } from '@/common';
import type { UsageSnapshot } from '@process/services/subscriptionUsage/types';

const EMPTY_SNAPSHOT: UsageSnapshot = { providers: [], fetchedAt: 0 };

export type UseUsage = {
  snapshot: UsageSnapshot;
  loading: boolean;
  refresh: () => Promise<void>;
};

export function useUsage(): UseUsage {
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (force: boolean): Promise<void> => {
    setLoading(true);
    try {
      setSnapshot(await ipcBridge.subscriptionUsage.snapshot.invoke({ force }));
    } catch {
      setSnapshot(EMPTY_SNAPSHOT);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const off = ipcBridge.subscriptionUsage.changed.on((next: UsageSnapshot) => setSnapshot(next));
    return off;
  }, [load]);

  const refresh = useCallback((): Promise<void> => load(true), [load]);

  return { snapshot, loading, refresh };
}
