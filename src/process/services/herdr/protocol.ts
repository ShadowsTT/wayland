/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure protocol helpers for herdr's Unix-socket JSON-RPC.
 *
 * Wire format is newline-delimited JSON: each request is one JSON object
 * (`{id, method, params}`) terminated by `\n`; each response/event is one JSON
 * object per line. Responses carry the request `id`; pushed events carry a
 * `data` field and no `id`. No IO lives here — only framing + path resolution.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the herdr server socket path. Prefers the injected env var (set by
 * herdr inside its own panes) and otherwise falls back to the XDG default the
 * herdr client uses: `$XDG_CONFIG_HOME/herdr/herdr.sock` → `~/.config/...`.
 */
export function resolveHerdrSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return join(configHome, 'herdr', 'herdr.sock');
}

/** Encode a single JSON-RPC request as a newline-terminated frame. */
export function encodeRequest(id: string, method: string, params: unknown): string {
  return `${JSON.stringify({ id, method, params })}\n`;
}

/** A response carrying a request id (success `result` or `error`). */
export type HerdrResponse = {
  id?: string;
  result?: unknown;
  error?: { code: string; message: string };
};

/** A pushed event line (from an events.subscribe stream). */
export type HerdrEventLine = { data?: unknown };

export type CreateLineReaderOptions = {
  /** Cap total buffered bytes to avoid unbounded growth on a hostile/corrupt stream. */
  maxBufferBytes?: number;
  onError?: (err: Error) => void;
};

const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Create a socket `data` handler that parses newline-delimited JSON and invokes
 * `onLine` per parsed object. Partial trailing lines are buffered across chunks.
 * Malformed JSON on a single line is skipped, not fatal.
 */
export function createLineReader(
  onLine: (msg: unknown) => void,
  options: CreateLineReaderOptions = {}
): (chunk: Buffer) => void {
  const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
  let buffer = '';
  let aborted = false;

  return (chunk: Buffer) => {
    if (aborted) return;
    buffer += chunk.toString('utf-8');
    if (buffer.length > maxBuffer) {
      aborted = true;
      buffer = '';
      options.onError?.(new Error(`herdr stream buffer exceeded ${maxBuffer} bytes`));
      return;
    }
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const trimmed = line.trim();
      if (trimmed) {
        try {
          onLine(JSON.parse(trimmed));
        } catch {
          // Skip a single malformed line; keep reading the stream.
        }
      }
      nl = buffer.indexOf('\n');
    }
  };
}

/** The events Wayland subscribes to for live dashboard refresh. */
export const HERDR_MONITOR_SUBSCRIPTIONS: Array<{ type: string }> = [
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.exited',
  'pane.agent_detected',
  'workspace.created',
  'workspace.updated',
  'workspace.renamed',
  'workspace.closed',
  'workspace.focused',
  'tab.created',
  'tab.closed',
  'layout.updated',
].map((type) => ({ type }));
