/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * STAGED Claude Pro/Max subscription → wcore routing (the Anthropic analog of the
 * ChatGPT `openai-chatgpt` path). A subscription is detected by the registry
 * bridge tag `v2:claude-subscription`; when the engine supports it AND the OAuth
 * credential is present, the spawn must resolve to `--provider anthropic-claude`
 * with NO key env var and NO `--base-url` (the engine owns api.anthropic.com and
 * reads the token from ~/.claude/.credentials.json).
 *
 * The feature ships DISABLED (`CLAUDE_SUBSCRIPTION_ENGINE_ENABLED = false`) because
 * the bundled engine has no Anthropic OAuth path yet. buildSpawnConfig's
 * `claudeSubscriptionEngineAvailable` option carries the already-gated "ready"
 * signal, so these tests drive both the on and off routing directly.
 */

import { describe, expect, it } from 'vitest';
import { buildSpawnConfig, CLAUDE_SUBSCRIPTION_ENGINE_ENABLED } from '../../src/process/agent/wcore/envBuilder';
import type { TProviderWithModel } from '../../src/common/config/storage';

function makeModel(platform: string, useModel: string, extra: Partial<TProviderWithModel> = {}): TProviderWithModel {
  return {
    id: 'test-provider',
    platform,
    name: 'Test Provider',
    baseUrl: '',
    apiKey: 'sk-ant-oat-subscription-token',
    useModel,
    ...extra,
  };
}

/** Attach the registry bridge tag the legacy mirror stamps (not a typed field). */
function withBridgeTag(model: TProviderWithModel, tag: string): TProviderWithModel {
  return { ...(model as object), __waylandModelRegistryBridge: tag } as unknown as TProviderWithModel;
}

const CLAUDE_SUB_TAG = 'v2:claude-subscription';
const workspace = '/tmp/test-workspace';

/** The value passed after `--provider` in the spawn args. */
function providerArg(args: string[]): string | undefined {
  const i = args.indexOf('--provider');
  return i === -1 ? undefined : args[i + 1];
}

describe('Claude subscription → wcore (staged anthropic-claude routing)', () => {
  it('the feature ships DISABLED (guards against an accidental flip landing on main)', () => {
    expect(CLAUDE_SUBSCRIPTION_ENGINE_ENABLED).toBe(false);
  });

  it('routes a claude-subscription model to --provider anthropic-claude when ready', () => {
    // A claude-subscription legacy row has platform 'openai-compatible' + the tag.
    const model = withBridgeTag(makeModel('openai-compatible', 'claude-opus-4-8'), CLAUDE_SUB_TAG);
    const { args, env, missingRequiredApiKey } = buildSpawnConfig(model, {
      workspace,
      claudeSubscriptionEngineAvailable: true,
    });
    expect(providerArg(args)).toBe('anthropic-claude');
    // Keyless: the OAuth bearer must NOT be presented as an x-api-key, and the
    // engine owns the host so no --base-url is emitted.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(args).not.toContain('--base-url');
    expect(missingRequiredApiKey).toBe(false);
  });

  it('does NOT route to anthropic-claude when the engine/credential is not ready (default)', () => {
    // Same tagged model, but the "ready" signal absent (the shipping default) →
    // falls through to the current behavior, never the staged slug.
    const model = withBridgeTag(makeModel('openai-compatible', 'claude-opus-4-8'), CLAUDE_SUB_TAG);
    const { args } = buildSpawnConfig(model, { workspace });
    expect(providerArg(args)).not.toBe('anthropic-claude');
  });

  it('leaves a genuine (non-subscription) anthropic model on the API-key surface even when ready', () => {
    // No bridge tag → a normal Anthropic API-key model. The staged arm must not
    // hijack it: it stays `--provider anthropic` with ANTHROPIC_API_KEY set.
    const { args, env } = buildSpawnConfig(
      makeModel('anthropic', 'claude-opus-4-8', { apiKey: 'sk-ant-real-api-key' }),
      {
        workspace,
        claudeSubscriptionEngineAvailable: true,
      }
    );
    expect(providerArg(args)).toBe('anthropic');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-real-api-key');
  });

  it('does not affect the ChatGPT-subscription routing (control)', () => {
    const model = withBridgeTag(makeModel('openai-compatible', 'gpt-5.6-sol'), 'v2:chatgpt-subscription');
    const { args } = buildSpawnConfig(model, { workspace, claudeSubscriptionEngineAvailable: true });
    expect(providerArg(args)).toBe('openai-chatgpt');
  });
});
