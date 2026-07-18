/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * DOM tests for LauncherRosterTable covering:
 *   - F4: a Suggest-produced row (matchedTerms set) renders its match-reason
 *     chip; a manual row (matchedTerms undefined) does not.
 *   - F7: per-row backend selector + slot-name input are hidden by default and
 *     appear only when the Advanced toggle is on; the recommended backend shows
 *     as a quiet label while collapsed.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

import LauncherRosterTable, { type RosterEntry } from '@/renderer/pages/teams/components/LauncherRosterTable';
import type { AssistantListItem } from '@/renderer/pages/settings/AssistantSettings/types';

const mkSpec = (id: string, name: string): AssistantListItem =>
  ({
    id,
    name,
    nameI18n: { 'en-US': name },
    descriptionI18n: { 'en-US': `${name} description` },
  }) as unknown as AssistantListItem;

const specialistsById = new Map<string, AssistantListItem>([
  ['ext-launch', mkSpec('ext-launch', 'Launch Strategist')],
  ['ext-copy', mkSpec('ext-copy', 'Copy')],
]);

// Leader came from Suggest (matchedTerms set); teammate was added manually
// (matchedTerms undefined).
const leader: RosterEntry = {
  specialistId: 'ext-launch',
  backend: 'gemini',
  slotName: '',
  matchedTerms: ['launch', 'funnel'],
};
const manualTeammate: RosterEntry = {
  specialistId: 'ext-copy',
  backend: 'claude',
  slotName: '',
};

const renderTable = () =>
  render(
    <LauncherRosterTable
      leader={leader}
      teammates={[manualTeammate]}
      backendOptions={['gemini', 'claude', 'wayland-core']}
      specialistsById={specialistsById}
      localeKey='en-US'
      onChangeLeaderBackend={vi.fn()}
      onChangeLeaderSlotName={vi.fn()}
      onRemoveLeader={vi.fn()}
      onChangeTeammateBackend={vi.fn()}
      onChangeTeammateSlotName={vi.fn()}
      onRemoveTeammate={vi.fn()}
      onAddTeammate={vi.fn()}
      onPickLeader={vi.fn()}
    />
  );

describe('LauncherRosterTable', () => {
  it('F4: shows the match-reason chip only on the suggested (leader) row', () => {
    renderTable();
    const chip = screen.getByTestId('launcher-match-leader');
    expect(chip.textContent).toBe('matched: launch, funnel');
    // Manual teammate has no matchedTerms -> no chip.
    expect(screen.queryByTestId('launcher-match-teammate-0')).toBeNull();
  });

  it('F4: renders "recommended" when matchedTerms is empty (default pick)', () => {
    render(
      <LauncherRosterTable
        leader={{ specialistId: 'ext-launch', backend: 'gemini', slotName: '', matchedTerms: [] }}
        teammates={[]}
        backendOptions={['gemini']}
        specialistsById={specialistsById}
        localeKey='en-US'
        onChangeLeaderBackend={vi.fn()}
        onChangeLeaderSlotName={vi.fn()}
        onRemoveLeader={vi.fn()}
        onChangeTeammateBackend={vi.fn()}
        onChangeTeammateSlotName={vi.fn()}
        onRemoveTeammate={vi.fn()}
        onAddTeammate={vi.fn()}
        onPickLeader={vi.fn()}
      />
    );
    expect(screen.getByTestId('launcher-match-leader').textContent).toBe('recommended');
  });

  it('F7: backend + slot controls hidden by default; quiet backend label shown', () => {
    renderTable();
    // Collapsed: slot-name input absent, quiet backend label present.
    expect(screen.queryByTestId('launcher-slotname-leader')).toBeNull();
    expect(screen.queryByTestId('launcher-backend-label-leader')?.textContent).toBe('gemini');
    expect(screen.queryByTestId('launcher-backend-label-teammate-0')?.textContent).toBe('claude');
  });

  it('F7: toggling Advanced reveals the slot-name input + backend pill', () => {
    renderTable();
    fireEvent.click(screen.getByTestId('launcher-advanced-toggle'));
    // Expanded: slot-name input appears, quiet label gone.
    expect(screen.queryByTestId('launcher-slotname-leader')).not.toBeNull();
    expect(screen.queryByTestId('launcher-backend-label-leader')).toBeNull();
    expect(screen.queryByTestId('launcher-slotname-teammate-0')).not.toBeNull();
  });
});
