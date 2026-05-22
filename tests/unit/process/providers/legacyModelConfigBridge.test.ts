/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the chat-start bridge (Packet 3A).
 *
 * The bridge is the transitional scaffold that mirrors a `modelRegistry`
 * connect / rekey / disconnect into the legacy `model.config` `ProcessConfig`
 * store so the home-screen picker's `handlePickCurated` can resolve a
 * provider that was connected ONLY through the new Models page.
 *
 * The bridge takes a structural `LegacyConfigStore` so the tests can use an
 * in-memory fake — no disk, no `ProcessConfig`, no Electron runtime.
 */

import { describe, expect, it } from 'vitest';
import type { IProvider } from '@/common/config/storage';
import { createLegacyModelConfigBridge, type LegacyConfigStore } from '@process/providers/ipc/legacyModelConfigBridge';

/** Build an in-memory `model.config` store seeded with the given rows. */
function makeStore(initial: IProvider[] = []): LegacyConfigStore & { get current(): IProvider[] } {
  let state: IProvider[] = [...initial];
  return {
    get current(): IProvider[] {
      return state;
    },
    async get() {
      return state;
    },
    async set(_key, value) {
      state = value;
    },
  };
}

describe('legacyModelConfigBridge', () => {
  it('writes an api-key provider as a tagged IProvider row chat-start can read', async () => {
    const store = makeStore();
    const bridge = createLegacyModelConfigBridge(store);

    await bridge.writeProvider('openai', { key: 'sk-test' }, ['gpt-4o', 'gpt-4o-mini']);

    expect(store.current).toHaveLength(1);
    const [row] = store.current;
    expect(row.platform).toBe('openai');
    expect(row.apiKey).toBe('sk-test');
    expect(row.baseUrl).toBe('https://api.openai.com/v1');
    expect(row.model).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(row.name).toBe('OpenAI');
    expect(row.id).toBeTruthy();
  });

  it('writes anthropic with the correct platform string and base URL', async () => {
    const store = makeStore();
    const bridge = createLegacyModelConfigBridge(store);

    await bridge.writeProvider('anthropic', { key: 'sk-ant-test' }, ['claude-sonnet-4-5']);

    expect(store.current[0].platform).toBe('anthropic');
    expect(store.current[0].baseUrl).toBe('https://api.anthropic.com');
    expect(store.current[0].apiKey).toBe('sk-ant-test');
  });

  it('writes an openai-compatible long-tail provider with its canonical baseUrl', async () => {
    const store = makeStore();
    const bridge = createLegacyModelConfigBridge(store);

    await bridge.writeProvider('groq', { key: 'gsk-test' }, ['llama-3.1-70b']);

    // Long-tail providers map to `openai-compatible` so legacy `mapProvider`
    // falls through to the OpenAI protocol on the stored baseUrl.
    expect(store.current[0].platform).toBe('openai-compatible');
    expect(store.current[0].baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(store.current[0].apiKey).toBe('gsk-test');
  });

  it('writes a bedrock provider with bedrockConfig populated from fields', async () => {
    const store = makeStore();
    const bridge = createLegacyModelConfigBridge(store);

    await bridge.writeProvider(
      'aws-bedrock',
      { fields: { accessKeyId: 'AKIA', secretAccessKey: 'secret', region: 'us-east-1' } },
      ['anthropic.claude-3-5-sonnet-20241022-v2:0']
    );

    const row = store.current[0];
    expect(row.platform).toBe('bedrock');
    expect(row.bedrockConfig).toEqual({
      authMethod: 'accessKey',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      region: 'us-east-1',
    });
    // Bedrock authenticates via bedrockConfig — apiKey and baseUrl are unused.
    expect(row.apiKey).toBe('');
    expect(row.baseUrl).toBe('');
  });

  it('updates an existing mirrored row in place, preserving its id', async () => {
    const store = makeStore();
    const bridge = createLegacyModelConfigBridge(store);

    await bridge.writeProvider('openai', { key: 'sk-old' }, ['gpt-4']);
    const firstId = store.current[0].id;

    await bridge.writeProvider('openai', { key: 'sk-new' }, ['gpt-4', 'gpt-4o']);

    expect(store.current).toHaveLength(1);
    expect(store.current[0].id).toBe(firstId);
    expect(store.current[0].apiKey).toBe('sk-new');
    expect(store.current[0].model).toEqual(['gpt-4', 'gpt-4o']);
  });

  it('removes a previously-written row on removeProvider', async () => {
    const store = makeStore();
    const bridge = createLegacyModelConfigBridge(store);

    await bridge.writeProvider('openai', { key: 'sk-test' }, ['gpt-4o']);
    expect(store.current).toHaveLength(1);

    await bridge.removeProvider('openai');
    expect(store.current).toHaveLength(0);
  });

  it('leaves a legacy ModelModalContent-created row with the same platform alone on remove', async () => {
    // A legacy row created by the old Settings → Model modal does NOT carry
    // the bridge tag. Removing the registry-mirrored OpenAI row must leave
    // the legacy row in place — the registry is not authoritative over rows
    // it did not create.
    const legacyRow: IProvider = {
      id: 'legacy-id',
      platform: 'openai',
      name: 'My Custom OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-legacy',
      model: ['gpt-4'],
    };
    const store = makeStore([legacyRow]);
    const bridge = createLegacyModelConfigBridge(store);

    // Write the registry mirror — this becomes a second `openai` row.
    await bridge.writeProvider('openai', { key: 'sk-registry' }, ['gpt-4o']);
    // Now there are two `openai` rows: the legacy one and the registry mirror.
    expect(store.current).toHaveLength(2);

    await bridge.removeProvider('openai');
    expect(store.current).toHaveLength(1);
    expect(store.current[0].id).toBe('legacy-id');
    expect(store.current[0].apiKey).toBe('sk-legacy');
  });

  it('does not adopt a pre-existing untagged legacy row sharing the same platform', async () => {
    // A pre-existing UNTAGGED row sharing the platform is the user's legacy
    // `ModelModalContent` config, not the bridge's. The bridge must add a
    // NEW tagged row beside it rather than clobbering the user's `apiKey`
    // / `baseUrl`. 3B's migration is the one place where these two rows
    // get reconciled.
    const untaggedRow: IProvider = {
      id: 'legacy-id',
      platform: 'openai',
      name: 'My Custom OpenAI',
      baseUrl: 'https://my-proxy.example.com',
      apiKey: 'sk-user-set',
      model: ['gpt-4'],
    };
    const store = makeStore([untaggedRow]);
    const bridge = createLegacyModelConfigBridge(store);

    await bridge.writeProvider('openai', { key: 'sk-registry' }, ['gpt-4o']);

    expect(store.current).toHaveLength(2);
    // The legacy row is preserved exactly.
    const legacy = store.current.find((p) => p.id === 'legacy-id');
    expect(legacy?.apiKey).toBe('sk-user-set');
    expect(legacy?.baseUrl).toBe('https://my-proxy.example.com');
    // The bridge added its own tagged row beside it.
    const mirrored = store.current.find((p) => p.id !== 'legacy-id');
    expect(mirrored?.apiKey).toBe('sk-registry');
  });

  it('is a defensive no-op when an unknown provider id is requested', async () => {
    const store = makeStore();
    const bridge = createLegacyModelConfigBridge(store);

    // An id outside `ProviderId` would never reach the bridge in production,
    // but the bridge must not fabricate a row for an unknown id either way.
    // The cast goes through `unknown` because the runtime guard is the point
    // of the test.
    await bridge.writeProvider('not-a-real-provider' as unknown as 'openai', { key: 'x' }, ['m']);

    expect(store.current).toHaveLength(0);
  });

  it('rejects a non-cloud provider connected via fields rather than a key', async () => {
    const store = makeStore();
    const bridge = createLegacyModelConfigBridge(store);

    // Standard providers always carry a `key` in the registry. A `fields`
    // payload on a non-cloud provider is a contract violation the bridge
    // refuses to mirror.
    await bridge.writeProvider('openai', { fields: { something: 'else' } }, ['gpt-4o']);

    expect(store.current).toHaveLength(0);
  });

  it('does not overwrite the user-set model array when the catalog is empty', async () => {
    // A registry refresh that produces an empty catalog (unlikely but
    // possible) replaces the row's `model[]`; this is the desired behavior —
    // an empty model list is also a legitimate state. The test pins it so a
    // future change does not silently drift.
    const store = makeStore();
    const bridge = createLegacyModelConfigBridge(store);

    await bridge.writeProvider('openai', { key: 'sk-test' }, ['gpt-4o']);
    expect(store.current[0].model).toEqual(['gpt-4o']);

    await bridge.writeProvider('openai', { key: 'sk-test' }, []);
    expect(store.current[0].model).toEqual([]);
  });
});
