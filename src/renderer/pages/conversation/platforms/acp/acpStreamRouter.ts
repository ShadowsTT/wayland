/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-conversation router for the ACP response stream.
 *
 * The ACP `responseStream` is a single emitter key: every subscriber receives
 * every conversation's every token, then filters by `conversation_id` in JS.
 * In team mode each agent mounts its own per-conversation consumers
 * (useAcpMessage, AcpModelSelector, AcpConfigSelector), so with N agents every
 * token woke all 3N handlers — O(N²) callback churn per second, even though
 * most calls immediately early-returned on the id mismatch.
 *
 * This router subscribes to the underlying emitter EXACTLY ONCE and dispatches
 * each message only to the listeners registered for that message's
 * `conversation_id`. That turns the per-token fan-out from O(agents) into O(1)
 * (a single Map lookup + the handful of listeners that actually own the
 * conversation). It is a pure renderer-side optimization: the IPC wire, the
 * bridge allowlist, and the WebSocket broadcast path are untouched.
 *
 * Note this deliberately covers only the per-conversation consumers. Genuinely
 * global consumers (e.g. the workspace-refresh listener that reacts to any
 * agent's tool call) are few and fixed in number, so they keep subscribing to
 * the emitter directly.
 */

import { ipcBridge } from '@/common';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';

type AcpStreamListener = (message: IResponseMessage) => void;

/** conversation_id → its registered listeners. */
const listenersByConversation = new Map<string, Set<AcpStreamListener>>();

/** Handle to the single underlying emitter subscription, or null when idle. */
let unsubscribeUnderlying: (() => void) | null = null;

function dispatch(message: IResponseMessage): void {
  const listeners = listenersByConversation.get(message.conversation_id);
  if (!listeners || listeners.size === 0) return;
  // Snapshot so a listener that (un)subscribes during dispatch can't mutate the
  // set we're iterating.
  for (const listener of Array.from(listeners)) {
    listener(message);
  }
}

function ensureSubscribed(): void {
  if (unsubscribeUnderlying) return;
  unsubscribeUnderlying = ipcBridge.acpConversation.responseStream.on(dispatch);
}

function teardownIfIdle(): void {
  if (listenersByConversation.size === 0 && unsubscribeUnderlying) {
    unsubscribeUnderlying();
    unsubscribeUnderlying = null;
  }
}

/**
 * Subscribe to the ACP response stream for a single conversation. The listener
 * is invoked only for messages whose `conversation_id` matches — callers no
 * longer need their own id guard (though keeping one is harmless).
 *
 * @returns an unsubscribe function; call it on effect cleanup.
 */
export function subscribeAcpResponseStream(conversationId: string, listener: AcpStreamListener): () => void {
  ensureSubscribed();

  let set = listenersByConversation.get(conversationId);
  if (!set) {
    set = new Set();
    listenersByConversation.set(conversationId, set);
  }
  set.add(listener);

  return () => {
    const current = listenersByConversation.get(conversationId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listenersByConversation.delete(conversationId);
    }
    teardownIfIdle();
  };
}
