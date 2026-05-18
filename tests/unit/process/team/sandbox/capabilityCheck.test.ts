/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * W4b — Tests for the capability-check helpers.
 *
 * Covers the four cells of the (sandboxed × granted) truth table plus the
 * `assertCapGranted` error-throwing surface.
 */

import { describe, expect, it } from 'vitest';
import { TeamSandboxedError } from '@process/team/importExport/errors';
import { assertCapGranted, isCapGranted } from '@process/team/sandbox/capabilityCheck';
import type { TTeam } from '@process/team/types';

const baseTeam: TTeam = {
  id: 'team-abc',
  userId: 'user-1',
  name: 'Imported Squad',
  workspace: '/tmp/ws',
  workspaceMode: 'shared',
  leaderAgentId: 'slot-1',
  agents: [],
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

describe('isCapGranted', () => {
  it('returns true for non-sandboxed teams regardless of grants map', () => {
    expect(isCapGranted({ ...baseTeam, isSandboxed: false }, 'canReadFiles')).toBe(true);
    expect(isCapGranted({ ...baseTeam }, 'canSpawnAgents')).toBe(true); // undefined === non-sandboxed
  });

  it('returns true for a sandboxed team with by_user: true grant', () => {
    const team: TTeam = {
      ...baseTeam,
      isSandboxed: true,
      importCapabilityGrants: {
        canReadFiles: { granted_at: 1700000000000, by_user: true },
      },
    };
    expect(isCapGranted(team, 'canReadFiles')).toBe(true);
  });

  it('returns false for a sandboxed team with by_user: false grant', () => {
    const team: TTeam = {
      ...baseTeam,
      isSandboxed: true,
      importCapabilityGrants: {
        canReadFiles: { granted_at: 1700000000000, by_user: false },
      },
    };
    expect(isCapGranted(team, 'canReadFiles')).toBe(false);
  });

  it('returns false for a sandboxed team with no grant entry for the capability', () => {
    const team: TTeam = {
      ...baseTeam,
      isSandboxed: true,
      importCapabilityGrants: {},
    };
    expect(isCapGranted(team, 'canWriteFiles')).toBe(false);
    expect(isCapGranted({ ...team, importCapabilityGrants: undefined }, 'canSpawnAgents')).toBe(
      false
    );
  });
});

describe('assertCapGranted', () => {
  it('does not throw when capability is granted', () => {
    expect(() => assertCapGranted({ ...baseTeam, isSandboxed: false }, 'canReadFiles')).not.toThrow();
  });

  it('throws TeamSandboxedError when capability is denied; message names the capability', () => {
    const team: TTeam = {
      ...baseTeam,
      isSandboxed: true,
      importCapabilityGrants: {},
    };
    let caught: unknown;
    try {
      assertCapGranted(team, 'canSpawnAgents');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TeamSandboxedError);
    const err = caught as TeamSandboxedError;
    expect(err.message).toMatch(/canSpawnAgents/);
    expect(err.code).toBe('TEAM_SANDBOXED');
  });
});
