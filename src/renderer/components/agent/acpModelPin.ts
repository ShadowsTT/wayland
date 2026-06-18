/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { FLUX_MODEL_DISPLAY, type FluxModelId } from '@/common/config/flux';
import type { AcpModelInfo } from '@/common/types/acpTypes';

/**
 * Resolve the model info to display after a refresh, honoring the user's pinned
 * selection. Background refreshes (the claude 1.5s poll, model-info reloads, and
 * stream updates) report the agent's CURRENT model, which after a turn is its
 * DEFAULT, not the model the user picked in this chat. Without a pin they
 * silently revert the user's selection back to Default (#136 / #146 / #149).
 *
 * A Flux tier is pinned whenever Flux is showable (the agent never reports it,
 * since it rides the spawn env). Otherwise, once the user has switched models
 * in-chat, the native selection is pinned as long as it is still offered.
 */
export function resolvePinnedModelInfo(
  next: AcpModelInfo,
  pins: { fluxModelId: FluxModelId | null; showFlux: boolean; userChangedModel: boolean; selectedModelId: string | null }
): AcpModelInfo {
  if (pins.fluxModelId && pins.showFlux) {
    return { ...next, currentModelId: pins.fluxModelId, currentModelLabel: FLUX_MODEL_DISPLAY[pins.fluxModelId] };
  }
  const sel = pins.selectedModelId;
  if (pins.userChangedModel && sel && next.currentModelId !== sel && next.availableModels.some((m) => m.id === sel)) {
    const label = next.availableModels.find((m) => m.id === sel)?.label || sel;
    return { ...next, currentModelId: sel, currentModelLabel: label };
  }
  return next;
}
