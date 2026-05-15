/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserWindow } from 'electron';
import { ipcBridge } from '@/common';

export const PROTOCOL_SCHEME = 'wayland';

/**
 * Parse an wayland:// URL into action and params.
 * Supports two formats:
 *   1. wayland://add-provider?baseUrl=xxx&apiKey=xxx
 *   2. wayland://provider/add?v=1&data=<base64 JSON>  (one-api / new-api style)
 */
export type DeepLinkParsed = {
  action: string;
  params: Record<string, string>;
  /**
   * Decoded base64-JSON payload from the `data` query param, if present and parseable.
   * Stored as `unknown` so consumers must explicitly validate the shape before use —
   * never spread into `params` (M8: prevents attacker-chosen keys from injecting
   * trusted-looking fields like `redirectUrl`, `apiKey`, `baseUrl`).
   */
  decoded?: unknown;
};

export const parseDeepLinkUrl = (url: string): DeepLinkParsed | null => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${PROTOCOL_SCHEME}:`) return null;

    const hostname = parsed.hostname || '';
    const pathname = parsed.pathname.replace(/^\/+/, '');
    const action = pathname ? `${hostname}/${pathname}` : hostname;

    const params: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      params[key] = value;
    });

    // If data param exists, decode base64 JSON and expose it under an explicit
    // `decoded` field. Consumers must opt in and validate the shape — keys are
    // NOT merged into `params` (would allow attacker-controlled injection).
    let decoded: unknown;
    if (params.data) {
      try {
        const json = JSON.parse(Buffer.from(params.data, 'base64').toString('utf-8'));
        if (json && typeof json === 'object') {
          decoded = json;
        }
      } catch {
        // ignore malformed base64 data
      }
      delete params.data;
    }

    return decoded !== undefined ? { action, params, decoded } : { action, params };
  } catch {
    return null;
  }
};

let mainWindowRef: BrowserWindow | null = null;
let pendingDeepLinkUrl: string | null = process.argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`)) || null;

export const setDeepLinkMainWindow = (win: BrowserWindow): void => {
  mainWindowRef = win;
};

export const getPendingDeepLinkUrl = (): string | null => pendingDeepLinkUrl;

export const clearPendingDeepLinkUrl = (): void => {
  pendingDeepLinkUrl = null;
};

/**
 * Send the deep-link payload to the renderer via IPC bridge.
 * If the window isn't ready yet, queue it.
 */
export const handleDeepLinkUrl = (url: string): void => {
  const parsed = parseDeepLinkUrl(url);
  if (!parsed) return;

  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    pendingDeepLinkUrl = url;
    return;
  }

  ipcBridge.deepLink.received.emit(parsed);
};
