import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import type { ITeamAgentStatusEvent, TeamAgent, TeammateStatus } from '@/common/types/teamTypes';

type AgentStatusInfo = {
  slotId: string;
  status: TeammateStatus;
  lastMessage?: string;
};

export type TeamStatusMap = Map<string, AgentStatusInfo>;

/**
 * Split out of TeamTabsContext (perf P1). Agent status events fire frequently;
 * baking `statusMap` into the chat-grid context re-rendered every column on
 * each flip. This provider owns the status state + the `agentStatusChanged`
 * subscription and hands the map to ONLY the surfaces that render live status
 * (the tab bar + right rail) via `useTeamStatusMap`. TeamPage renders this
 * provider above a stable `children` element, so a status event re-renders the
 * provider + its map consumers, never TeamPageContent or the chat grid.
 *
 * `useTeamStatusRef` exposes a stable ref (identity never changes) for handlers
 * that need to read the current status at call time without subscribing.
 */
const TeamStatusMapContext = createContext<TeamStatusMap | null>(null);
const TeamStatusRefContext = createContext<React.MutableRefObject<TeamStatusMap> | null>(null);

export const TeamStatusProvider: React.FC<{
  teamId: string;
  agents: TeamAgent[];
  children: React.ReactNode;
}> = ({ teamId, agents, children }) => {
  const [statusMap, setStatusMap] = useState<TeamStatusMap>(
    () => new Map(agents.map((a) => [a.slotId, { slotId: a.slotId, status: a.status }]))
  );

  // Keep a fresh ref for imperative reads (e.g. remove-confirm) without forcing
  // subscribers to re-render. Writing a ref during render is idempotent here.
  const statusRef = useRef(statusMap);
  statusRef.current = statusMap;

  useEffect(() => {
    const unsubStatus = ipcBridge.team.agentStatusChanged.on((event: ITeamAgentStatusEvent) => {
      if (event.teamId !== teamId) return;
      setStatusMap((prev) => {
        const next = new Map(prev);
        next.set(event.slotId, { slotId: event.slotId, status: event.status, lastMessage: event.lastMessage });
        return next;
      });
    });
    return () => {
      unsubStatus();
    };
  }, [teamId]);

  const refValue = useMemo(() => statusRef, []);

  return (
    <TeamStatusRefContext.Provider value={refValue}>
      <TeamStatusMapContext.Provider value={statusMap}>{children}</TeamStatusMapContext.Provider>
    </TeamStatusRefContext.Provider>
  );
};

export const useTeamStatusMap = (): TeamStatusMap => {
  const ctx = useContext(TeamStatusMapContext);
  if (!ctx) throw new Error('useTeamStatusMap must be used within TeamStatusProvider');
  return ctx;
};

export const useTeamStatusRef = (): React.MutableRefObject<TeamStatusMap> => {
  const ctx = useContext(TeamStatusRefContext);
  if (!ctx) throw new Error('useTeamStatusRef must be used within TeamStatusProvider');
  return ctx;
};
