/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { UsageEventLogger } from '@process/services/usage/UsageEventLogger';
import type { UsageEventType } from '@process/services/usage/types';

/**
 * IPC surface for usage telemetry. Single endpoint:
 *   - recordEvent(input) — fire-and-forget; main-process logger persists
 *     to the usage_events table (migration v40). Renderer never blocks
 *     on the result and never sees errors (the logger swallows them too).
 */
export function initUsageBridge(logger: UsageEventLogger): void {
  ipcBridge.usage.recordEvent.provider(async (input) => {
    await logger.record({
      eventType: input.eventType as UsageEventType,
      anchorId: input.anchorId,
      assistantId: input.assistantId,
      cliBackend: input.cliBackend,
      metadata: input.metadata,
    });
  });
}
