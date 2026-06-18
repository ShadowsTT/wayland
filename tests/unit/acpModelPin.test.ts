import { describe, expect, it } from 'vitest';

import { FLUX_MODEL_IDS } from '@/common/config/flux';
import type { AcpModelInfo } from '@/common/types/acpTypes';
import { resolvePinnedModelInfo } from '@renderer/components/agent/acpModelPin';

const info = (currentModelId: string, ids: string[]): AcpModelInfo => ({
  source: 'models',
  sourceDetail: 'test',
  currentModelId,
  currentModelLabel: currentModelId,
  canSwitch: true,
  availableModels: ids.map((id) => ({ id, label: id.toUpperCase() })),
});

const NO_PINS = { fluxModelId: null, showFlux: false, userChangedModel: false, selectedModelId: null };

describe('resolvePinnedModelInfo', () => {
  it('pins the user in-chat selection when a refresh reports the agent default (#136/#146/#149)', () => {
    // This is the bug: the 1.5s poll reports `default`; the user picked `opus`.
    const out = resolvePinnedModelInfo(info('default', ['opus', 'default']), {
      ...NO_PINS,
      userChangedModel: true,
      selectedModelId: 'opus',
    });
    expect(out.currentModelId).toBe('opus');
    expect(out.currentModelLabel).toBe('OPUS');
  });

  it('does NOT pin before the user has changed the model (lets the agent value through)', () => {
    const next = info('default', ['opus', 'default']);
    const out = resolvePinnedModelInfo(next, { ...NO_PINS, userChangedModel: false, selectedModelId: 'opus' });
    expect(out).toBe(next); // unchanged reference
    expect(out.currentModelId).toBe('default');
  });

  it('does NOT pin a selection that is no longer offered', () => {
    const next = info('default', ['opus', 'default']);
    const out = resolvePinnedModelInfo(next, { ...NO_PINS, userChangedModel: true, selectedModelId: 'gone' });
    expect(out).toBe(next);
    expect(out.currentModelId).toBe('default');
  });

  it('is a no-op when the refresh already reports the selected model', () => {
    const next = info('opus', ['opus', 'default']);
    const out = resolvePinnedModelInfo(next, { ...NO_PINS, userChangedModel: true, selectedModelId: 'opus' });
    expect(out).toBe(next);
  });

  it('pins a Flux tier ahead of a native selection when Flux is showable', () => {
    const flux = FLUX_MODEL_IDS[0];
    const out = resolvePinnedModelInfo(info('sonnet', ['sonnet', 'opus']), {
      fluxModelId: flux,
      showFlux: true,
      userChangedModel: true,
      selectedModelId: 'opus',
    });
    expect(out.currentModelId).toBe(flux);
  });

  it('ignores the Flux pin when Flux is not showable, falling back to the native pin', () => {
    const flux = FLUX_MODEL_IDS[0];
    const out = resolvePinnedModelInfo(info('default', ['opus', 'default']), {
      fluxModelId: flux,
      showFlux: false,
      userChangedModel: true,
      selectedModelId: 'opus',
    });
    expect(out.currentModelId).toBe('opus');
  });
});
