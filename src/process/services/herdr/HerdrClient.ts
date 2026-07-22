/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Low-level herdr socket IO: one-shot request/response calls and a persistent,
 * self-reconnecting event subscription. Mirrors how the herdr CLI itself talks
 * to the server — a short-lived connection per request keeps request state
 * trivial and matches herdr's own `herdr api snapshot` behavior.
 */

import * as net from 'node:net';
import { createLineReader, encodeRequest } from './protocol';
import type { HerdrResponse } from './protocol';

const DEFAULT_TIMEOUT_MS = 5_000;

export class HerdrClient {
  private seq = 0;

  constructor(private readonly socketPath: string) {}

  /**
   * Send one request and resolve its `result` (or reject on error/timeout).
   * Opens a dedicated connection, writes the frame, reads the first line whose
   * id matches, then closes.
   */
  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = `wl:${method}:${++this.seq}`;
      const sock = net.connect(this.socketPath);
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        fn();
      };

      const timer = setTimeout(() => finish(() => reject(new Error(`herdr ${method} timed out`))), timeoutMs);

      const read = createLineReader((msg) => {
        const res = msg as HerdrResponse;
        if (res && res.id === id) {
          if (res.error) finish(() => reject(new Error(res.error?.message || `herdr ${method} failed`)));
          else finish(() => resolve(res.result as T));
        }
      });

      sock.on('connect', () => sock.write(encodeRequest(id, method, params)));
      sock.on('data', read);
      sock.on('error', (err) => finish(() => reject(err)));
      sock.on('close', () => finish(() => reject(new Error(`herdr connection closed before ${method} replied`))));
    });
  }
}

/**
 * A persistent subscription to herdr's event stream. Reconnects automatically
 * (herdr may be started/restarted after Wayland). Each pushed event's `data`
 * payload is delivered to `onEvent`; the consumer typically debounces a full
 * snapshot refresh rather than diffing individual events.
 */
export class HerdrEventStream {
  private sock: net.Socket | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly subscriptions: Array<{ type: string }>,
    private readonly onEvent: (data: unknown) => void,
    private readonly reconnectDelayMs = 5_000
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.sock?.destroy();
    this.sock = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const sock = net.connect(this.socketPath);
    this.sock = sock;

    const read = createLineReader((msg) => {
      const line = msg as { data?: unknown; id?: string };
      // Skip the initial `{id, result:{type:'subscription_started'}}` ack; real
      // events arrive as `{data:{...}}` lines with no id.
      if (line && line.data !== undefined) this.onEvent(line.data);
    });

    sock.on('connect', () => {
      sock.write(encodeRequest('wl:events', 'events.subscribe', { subscriptions: this.subscriptions }));
    });
    sock.on('data', read);
    // Errors are expected when herdr isn't running yet; stay quiet and retry.
    sock.on('error', () => {});
    sock.on('close', () => {
      if (this.sock === sock) this.sock = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }
}
