/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * Wave 5 Task 5.1a — DOM tests for HomeTab.
 *
 * Covers:
 *   - Loading state renders the shared MCPVerbCard spinner.
 *   - Wiki entries render as clickable rows; clicking switches tab+slug.
 *   - Empty wiki payload shows the empty slot copy.
 *   - Promote button calls brainInvoke('wiki.promote') and refreshes
 *     candidates on success.
 *   - Error state surfaces the localized memory.error.* key from MCPVerbCard.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type InvokeArgs = { verb: string; args?: Record<string, unknown> };
type InvokeResult = { ok: true; data?: unknown } | { ok: false; error?: string; errorReason?: string };

const { brainInvokeMock, messageSuccessSpy, messageErrorSpy } = vi.hoisted(() => ({
  brainInvokeMock: vi.fn<(args: InvokeArgs) => Promise<InvokeResult>>(),
  messageSuccessSpy: vi.fn(),
  messageErrorSpy: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    ijfw: {
      brainInvoke: { invoke: brainInvokeMock },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => {
      if (opts?.defaultValue !== undefined && key === 'memory.error.gibberish') {
        return opts.defaultValue;
      }
      return key;
    },
  }),
}));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return {
    ...actual,
    Message: {
      ...actual.Message,
      success: messageSuccessSpy,
      error: messageErrorSpy,
    },
  };
});

import HomeTab from '@renderer/pages/memory/tabs/HomeTab';

const LocationProbe: React.FC<{ onChange: (search: string) => void }> = ({ onChange }) => {
  const loc = useLocation();
  React.useEffect(() => {
    onChange(loc.search);
  }, [loc.search, onChange]);
  return null;
};

const renderHome = (initialEntries: string[] = ['/memory']) => {
  const searches: string[] = [];
  const utils = render(
    <MemoryRouter initialEntries={initialEntries}>
      <HomeTab />
      <LocationProbe onChange={(s) => searches.push(s)} />
    </MemoryRouter>
  );
  return { ...utils, searches };
};

/**
 * Default mock: wiki.get returns one entry, links returns one badge,
 * memory_facts returns one promotable candidate. Tests can override per-call
 * via `mockImplementationOnce` chains before calling renderHome.
 */
const setupDefaultMocks = (): void => {
  brainInvokeMock.mockImplementation(async ({ verb }) => {
    if (verb === 'wiki.get') {
      return { ok: true, data: { entries: [{ slug: 'auth', title: 'Auth decisions' }] } };
    }
    if (verb === 'links') {
      return {
        ok: true,
        data: { links: [{ from: 'sean', to: 'auth', type: 'decided' }] },
      };
    }
    if (verb === 'memory_facts') {
      return {
        ok: true,
        data: { candidates: [{ id: 'cand-1', preview: 'Stripe webhooks are idempotent' }] },
      };
    }
    if (verb === 'wiki.promote') {
      return { ok: true };
    }
    return { ok: false, errorReason: 'unknown' };
  });
};

beforeEach(() => {
  brainInvokeMock.mockReset();
  messageSuccessSpy.mockReset();
  messageErrorSpy.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('HomeTab', () => {
  it('renders the three section headers and the loading spinners until data resolves', () => {
    brainInvokeMock.mockReturnValue(new Promise(() => {}));
    renderHome();
    expect(screen.getByTestId('memory-tab-home')).toBeTruthy();
    // Three sections × one MCPVerbCard each → three loading spinners.
    const spinners = screen.getAllByTestId('mcp-verb-card-loading');
    expect(spinners.length).toBe(3);
  });

  it('renders wiki rows once wiki.get resolves with entries', async () => {
    setupDefaultMocks();
    renderHome();
    const row = await screen.findByTestId('memory-home-wiki-row-auth');
    expect(row.textContent).toContain('Auth decisions');
  });

  it('shows the empty wiki copy when wiki.get returns an empty entries array', async () => {
    brainInvokeMock.mockImplementation(async ({ verb }) => {
      if (verb === 'wiki.get') return { ok: true, data: { entries: [] } };
      return { ok: true, data: { links: [], candidates: [] } };
    });
    renderHome();
    await waitFor(() => {
      expect(screen.queryAllByTestId('mcp-verb-card-loading').length).toBe(0);
    });
    // Empty slot copy matches the i18n key for the wiki empty state.
    expect(screen.getByText('memory.home.wiki_empty')).toBeTruthy();
  });

  it('clicking a wiki row updates the URL to ?tab=wiki&slug=<slug>', async () => {
    setupDefaultMocks();
    const { searches } = renderHome();
    const row = await screen.findByTestId('memory-home-wiki-row-auth');
    fireEvent.click(row);
    await waitFor(() => {
      const latest = searches[searches.length - 1] ?? '';
      expect(latest).toContain('tab=wiki');
      expect(latest).toContain('slug=auth');
    });
  });

  it('Promote click invokes brainInvoke with wiki.promote and shows success on ok', async () => {
    setupDefaultMocks();
    renderHome();
    const promote = await screen.findByTestId('memory-home-promote-cand-1');

    // Make wiki.promote resolve ok; the refresh call after success also needs
    // to resolve, so keep the default impl for the second memory_facts call.
    await act(async () => {
      fireEvent.click(promote);
    });

    await waitFor(() => {
      expect(brainInvokeMock).toHaveBeenCalledWith({
        verb: 'wiki.promote',
        args: { id: 'cand-1' },
      });
    });
    await waitFor(() => {
      expect(messageSuccessSpy).toHaveBeenCalledWith('memory.home.promote_success');
    });
  });

  it('surfaces the localized error message when MCPVerbCard receives ok:false', async () => {
    brainInvokeMock.mockImplementation(async ({ verb }) => {
      if (verb === 'wiki.get') return { ok: false, errorReason: 'mcp_error' };
      return { ok: true, data: { links: [], candidates: [] } };
    });
    renderHome();
    const errorNode = await screen.findByTestId('mcp-verb-card-error');
    expect(errorNode.textContent).toBe('memory.error.mcp_error');
  });
});
