/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for #286: on macOS a `.dmg` recommendedAsset is always
 * present, so UpdateModal.startDownload() used to take the manual-download
 * branch and `return` before ever reaching the electron-updater path. That made
 * the quit + install + relaunch flow (autoUpdate.download -> 'downloaded' ->
 * Install now -> quitAndInstall) dead code on macOS: the user only got a DMG
 * dropped in ~/Downloads, never an in-place install/relaunch.
 *
 * After the fix, startDownload prefers autoUpdate.download whenever auto-update
 * is available, and only falls back to the manual asset when it is not.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

// Keep the modal + markdown lightweight so the button always renders when visible.
vi.mock('@/renderer/components/base/WaylandModal', () => ({
  default: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
    visible ? <div data-testid='modal'>{children}</div> : null,
}));
vi.mock('@/renderer/components/Markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const { autoUpdateDownload, manualDownload, autoUpdateCheck, manualCheck } = vi.hoisted(() => ({
  autoUpdateDownload: vi.fn(),
  manualDownload: vi.fn(),
  autoUpdateCheck: vi.fn(),
  manualCheck: vi.fn(),
}));

vi.mock('@/common/adapter/ipcBridge', () => {
  const noop = () => () => {};
  return {
    conversation: {},
    update: {
      open: { on: noop },
      check: { invoke: manualCheck },
      download: { invoke: manualDownload },
      downloadProgress: { on: noop },
    },
    autoUpdate: {
      check: { invoke: autoUpdateCheck },
      download: { invoke: autoUpdateDownload },
      quitAndInstall: { invoke: vi.fn() },
      status: { on: noop },
    },
    shell: {
      openExternal: { invoke: vi.fn() },
      openFile: { invoke: vi.fn() },
      showItemInFolder: { invoke: vi.fn() },
    },
    ijfw: { triggerInstall: { invoke: vi.fn() } },
  };
});

import UpdateModal from '@/renderer/components/settings/UpdateModal';

const RECOMMENDED_ASSET = {
  url: 'https://cdn.example.com/Wayland-0.11.12-arm64.dmg',
  fallbackUrl: 'https://github.com/FerroxLabs/wayland/releases/download/v0.11.12/Wayland-0.11.12-arm64.dmg',
  name: 'Wayland-0.11.12-arm64.dmg',
};

const LATEST = (withAsset: boolean) => ({
  version: '0.11.12',
  tagName: 'v0.11.12',
  htmlUrl: 'https://github.com/FerroxLabs/wayland/releases/tag/v0.11.12',
  name: 'Wayland 0.11.12',
  body: 'notes',
  recommendedAsset: withAsset ? RECOMMENDED_ASSET : undefined,
});

const openModal = async () => {
  render(<UpdateModal />);
  await act(async () => {
    window.dispatchEvent(new Event('wayland-open-update-modal'));
  });
};

describe('UpdateModal download priority (#286)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    autoUpdateDownload.mockResolvedValue({ success: true });
    manualDownload.mockResolvedValue({ success: true, data: { downloadId: 'd1', filePath: '/tmp/x.dmg' } });
  });

  it('prefers electron-updater over the manual DMG when auto-update is available (mac case)', async () => {
    // mac: BOTH auto-update available AND a .dmg recommendedAsset present.
    autoUpdateCheck.mockResolvedValue({ success: true, data: { updateInfo: { version: '0.11.12' } } });
    manualCheck.mockResolvedValue({
      success: true,
      data: { currentVersion: '0.11.11', latest: LATEST(true), updateAvailable: true },
    });

    await openModal();

    const btn = await screen.findByText('update.downloadAndInstall');
    fireEvent.click(btn);

    await waitFor(() => expect(autoUpdateDownload).toHaveBeenCalledTimes(1));
    expect(manualDownload).not.toHaveBeenCalled();
  });

  it('falls back to the manual asset only when auto-update is unavailable', async () => {
    // Auto-update check fails; manual check still finds a compatible .dmg asset.
    autoUpdateCheck.mockResolvedValue({ success: false, msg: 'no yml' });
    manualCheck.mockResolvedValue({
      success: true,
      data: { currentVersion: '0.11.11', latest: LATEST(true), updateAvailable: true },
    });

    await openModal();

    const btn = await screen.findByText('update.downloadButton');
    fireEvent.click(btn);

    await waitFor(() => expect(manualDownload).toHaveBeenCalledTimes(1));
    expect(autoUpdateDownload).not.toHaveBeenCalled();
    // The manual path forwards the CDN-rewritten asset URL + release tag.
    expect(manualDownload).toHaveBeenCalledWith(
      expect.objectContaining({ url: RECOMMENDED_ASSET.url, tagName: 'v0.11.12' })
    );
  });
});
