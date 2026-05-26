/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * Task 3.3 — DOM tests for the SiderMemoryEntry navigation row.
 *
 * Mirrors the patterns established by `SiderScheduledEntry` /
 * `SiderWorkflowsEntry` / `SiderTeamsEntry`:
 *   - Click invokes the supplied `onClick` handler.
 *   - Collapsed mode renders an icon-only row (tested via testid).
 *   - Expanded mode renders the literal label.
 *   - Active class is applied when `isActive` is true.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Wave 7 H4: the entry now resolves its label via `useTranslation()`. Mock
// react-i18next so the test asserts on the i18n key path explicitly — if the
// component is wired to a wrong key, the test fails. Mirrors the pattern used
// by other Sider sub-component DOM tests.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// eslint-disable-next-line import/first
import SiderMemoryEntry from '@renderer/components/layout/Sider/SiderNav/SiderMemoryEntry';
// eslint-disable-next-line import/first
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

const tooltipProps: SiderTooltipProps = {
  trigger: 'hover',
  disabled: true,
};

afterEach(() => {
  cleanup();
});

describe('SiderMemoryEntry', () => {
  // Wave 7 H4: assertion is now on the i18n key path. The mocked t() returns
  // the key, so the rendered text is `sider.memory` — proves the component
  // resolves through i18n instead of a hardcoded literal.
  it('renders the sider.memory label when expanded', () => {
    render(
      <SiderMemoryEntry
        isMobile={false}
        isActive={false}
        collapsed={false}
        siderTooltipProps={tooltipProps}
        onClick={vi.fn()}
      />
    );
    expect(screen.getByTestId('sider-memory-entry')).toBeTruthy();
    expect(screen.getByText('sider.memory')).toBeTruthy();
  });

  it('hides the label and renders icon-only when collapsed', () => {
    render(
      <SiderMemoryEntry
        isMobile={false}
        isActive={false}
        collapsed
        siderTooltipProps={tooltipProps}
        onClick={vi.fn()}
      />
    );
    expect(screen.getByTestId('sider-memory-entry')).toBeTruthy();
    expect(screen.queryByText('sider.memory')).toBeNull();
  });

  it('invokes onClick when clicked', () => {
    const onClick = vi.fn();
    render(
      <SiderMemoryEntry
        isMobile={false}
        isActive={false}
        collapsed={false}
        siderTooltipProps={tooltipProps}
        onClick={onClick}
      />
    );
    fireEvent.click(screen.getByTestId('sider-memory-entry'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('applies the active styling when isActive is true', () => {
    render(
      <SiderMemoryEntry
        isMobile={false}
        isActive
        collapsed={false}
        siderTooltipProps={tooltipProps}
        onClick={vi.fn()}
      />
    );
    const node = screen.getByTestId('sider-memory-entry');
    // Active state uses the primary-tinted bg utility; matches the pattern
    // used in SiderScheduledEntry / SiderWorkflowsEntry / SiderTeamsEntry.
    expect(node.className).toContain('text-primary');
  });
});
