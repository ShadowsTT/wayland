/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * Perf P1 regression: status flips must re-render status consumers only, not
 * the chat-grid slots. TeamStatusProvider exposes the live map via
 * useTeamStatusMap (subscribing) and a stable ref via useTeamStatusRef (not
 * subscribing). A ref-consuming, memo'd slot must NOT re-render when a status
 * event fires; a map consumer must.
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ITeamAgentStatusEvent, TeamAgent } from '@/common/types/teamTypes';

const statusListeners: Array<(e: ITeamAgentStatusEvent) => void> = [];

vi.mock('@/common', () => ({
  ipcBridge: {
    team: {
      agentStatusChanged: {
        on: (cb: (e: ITeamAgentStatusEvent) => void) => {
          statusListeners.push(cb);
          return () => {
            const i = statusListeners.indexOf(cb);
            if (i >= 0) statusListeners.splice(i, 1);
          };
        },
      },
    },
  },
}));

import { TeamStatusProvider, useTeamStatusMap, useTeamStatusRef } from '@/renderer/pages/team/hooks/TeamStatusContext';

let slotRenders = 0;

// Memo'd slot standing in for AgentChatSlot: reads the STABLE ref, not the map.
const Slot = React.memo(function Slot() {
  useTeamStatusRef();
  slotRenders++;
  return <div data-testid='slot' />;
});

const StatusReader: React.FC<{ slotId: string }> = ({ slotId }) => {
  const map = useTeamStatusMap();
  return <div data-testid='status'>{map.get(slotId)?.status ?? 'none'}</div>;
};

const agents: TeamAgent[] = [
  {
    slotId: 's1',
    conversationId: 'c1',
    role: 'leader',
    agentType: 'acp',
    agentName: 'A',
    conversationType: 'acp',
    status: 'idle',
  },
];

describe('TeamStatusProvider split', () => {
  it('re-renders map consumers but not ref-consuming memo slots on a status flip', () => {
    slotRenders = 0;
    statusListeners.length = 0;

    render(
      <TeamStatusProvider teamId='team-1' agents={agents}>
        <Slot />
        <StatusReader slotId='s1' />
      </TeamStatusProvider>
    );

    expect(screen.getByTestId('status').textContent).toBe('idle');
    const rendersBeforeFlip = slotRenders;

    act(() => {
      for (const cb of statusListeners) {
        cb({ teamId: 'team-1', slotId: 's1', status: 'active' } as ITeamAgentStatusEvent);
      }
    });

    // Map consumer reflects the new status...
    expect(screen.getByTestId('status').textContent).toBe('active');
    // ...but the memo'd ref-consuming slot did not re-render.
    expect(slotRenders).toBe(rendersBeforeFlip);
  });

  it('ignores status events for a different team', () => {
    statusListeners.length = 0;
    render(
      <TeamStatusProvider teamId='team-1' agents={agents}>
        <StatusReader slotId='s1' />
      </TeamStatusProvider>
    );
    expect(screen.getByTestId('status').textContent).toBe('idle');

    act(() => {
      for (const cb of statusListeners) {
        cb({ teamId: 'other-team', slotId: 's1', status: 'active' } as ITeamAgentStatusEvent);
      }
    });

    expect(screen.getByTestId('status').textContent).toBe('idle');
  });
});
