/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { getGeminiSubscriptionStatus } from '../services/geminiSubscription';

export function initGeminiBridge(): void {
  // Expose CLI subscription status to renderer.
  ipcBridge.gemini.subscriptionStatus.provider(async ({ proxy }) => {
    try {
      const status = await getGeminiSubscriptionStatus(proxy);
      return { success: true, data: status };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
