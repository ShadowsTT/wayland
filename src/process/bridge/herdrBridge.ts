/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the herdr integration. Wires the renderer's ipcBridge.herdr
 * providers to HerdrService and pushes a debounced, freshly-shaped view on the
 * `changed` emitter whenever herdr reports a workspace/pane/agent change.
 */

import { ipcBridge } from '@/common';
import { getHerdrService } from '@process/services/herdr';

const EMIT_DEBOUNCE_MS = 200;

export function initHerdrBridge(): void {
  const svc = getHerdrService();

  ipcBridge.herdr.isAvailable.provider(async () => svc.isAvailable());
  ipcBridge.herdr.getView.provider(async () => svc.getView());
  ipcBridge.herdr.sendPrompt.provider(async ({ paneId, text, submit }) => svc.sendPrompt(paneId, text, submit ?? true));
  ipcBridge.herdr.sendKeys.provider(async ({ paneId, keys }) => svc.sendKeys(paneId, keys));
  ipcBridge.herdr.focusPane.provider(async ({ paneId }) => svc.focusPane(paneId));
  ipcBridge.herdr.focusWorkspace.provider(async ({ workspaceId }) => svc.focusWorkspace(workspaceId));
  ipcBridge.herdr.renamePane.provider(async ({ paneId, label }) => svc.renamePane(paneId, label));
  ipcBridge.herdr.startAgent.provider(async (params) => svc.startAgent(params));
  ipcBridge.herdr.createWorktree.provider(async (params) => svc.createWorktree(params));
  ipcBridge.herdr.readPane.provider(async ({ paneId, lines }) => svc.readPane(paneId, lines));

  // Live updates: herdr fires many fine-grained events; collapse a burst into a
  // single fresh snapshot push so the renderer just replaces its state.
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const scheduleEmit = (): void => {
    if (debounce) return;
    debounce = setTimeout(async () => {
      debounce = null;
      try {
        const view = await svc.getView();
        ipcBridge.herdr.changed.emit(view);
      } catch (err) {
        console.error('[herdr] view emit failed:', err);
      }
    }, EMIT_DEBOUNCE_MS);
  };

  // The stream self-reconnects, so this is safe even if herdr starts later.
  svc.subscribe(scheduleEmit);
}

export function stopHerdrBridge(): void {
  getHerdrService().dispose();
}
