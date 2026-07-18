// src/renderer/pages/team/hooks/useTeamSession.ts
import { ipcBridge } from '@/common';
import type {
  ITeamAgentRemovedEvent,
  ITeamAgentRenamedEvent,
  ITeamAgentSpawnedEvent,
  ITeamListChangedEvent,
  TeamAgent,
  TTeam,
} from '@/common/types/teamTypes';
import { useCallback, useEffect } from 'react';
import useSWR from 'swr';

export function useTeamSession(team: TTeam) {
  const { mutate: mutateTeam } = useSWR(team.id ? `team/${team.id}` : null, () =>
    ipcBridge.team.get.invoke({ id: team.id })
  );

  useEffect(() => {
    void ipcBridge.team.ensureSession.invoke({ teamId: team.id });

    const unsubSpawned = ipcBridge.team.agentSpawned.on((event: ITeamAgentSpawnedEvent) => {
      if (event.teamId !== team.id) return;
      void mutateTeam();
    });

    const unsubRemoved = ipcBridge.team.agentRemoved.on((event: ITeamAgentRemovedEvent) => {
      if (event.teamId !== team.id) return;
      void mutateTeam();
    });

    const unsubRenamed = ipcBridge.team.agentRenamed.on((event: ITeamAgentRenamedEvent) => {
      if (event.teamId !== team.id) return;
      void mutateTeam();
    });

    // W3b - promote/demote toggles emit listChanged('standing_changed');
    // refresh the cached team so promotedToStanding flips in the UI.
    const unsubListChanged = ipcBridge.team.listChanged.on((event: ITeamListChangedEvent) => {
      if (event.teamId !== team.id) return;
      if (event.action === 'standing_changed') {
        void mutateTeam();
      }
    });

    return () => {
      unsubSpawned();
      unsubRemoved();
      unsubRenamed();
      unsubListChanged();
    };
  }, [team.id, mutateTeam]);

  const sendMessage = useCallback(
    async (content: string) => {
      await ipcBridge.team.sendMessage.invoke({ teamId: team.id, content });
    },
    [team.id]
  );

  const addAgent = useCallback(
    async (agent: Omit<TeamAgent, 'slotId'>) => {
      await ipcBridge.team.addAgent.invoke({ teamId: team.id, agent });
      await mutateTeam();
    },
    [team.id, mutateTeam]
  );

  const renameAgent = useCallback(
    async (slotId: string, newName: string) => {
      await ipcBridge.team.renameAgent.invoke({ teamId: team.id, slotId, newName });
      await mutateTeam();
    },
    [team.id, mutateTeam]
  );

  const removeAgent = useCallback(
    async (slotId: string) => {
      await ipcBridge.team.removeAgent.invoke({ teamId: team.id, slotId });
      await mutateTeam();
    },
    [team.id, mutateTeam]
  );

  return { sendMessage, addAgent, renameAgent, removeAgent, mutateTeam };
}
