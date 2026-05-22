/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Legacy `model.config` bridge (Packet 3A — transitional).
 *
 * The chat-start path on the home screen reads providers from the legacy
 * `model.config` `ProcessConfig` key via `mode.getModelConfig` — `IProvider[]`
 * carrying `apiKey` / `baseUrl` / `model[]`. The new `modelRegistry` namespace
 * (Wave 1 backend) owns its own encrypted SQLite tables and never touches
 * `model.config`. A user who connects a provider only via the new Models page
 * would therefore not be able to start a chat from the home model picker — the
 * legacy store has no record of the provider.
 *
 * This bridge mirrors a successful `modelRegistry.connect` (or `rekey`) into
 * `model.config` so the home picker's `handlePickCurated` still finds a
 * matching `IProvider`. On `disconnect` the mirrored row is removed. It is a
 * temporary scaffold — Packet 3B's migration flips chat-start to read from
 * `modelRegistry` directly and deletes this file along with the legacy store.
 *
 * **Scope:** API-key providers and cloud providers (Bedrock writes a real
 * `bedrockConfig`; Vertex / Azure write a best-effort row with `platform` set
 * to a value chat-start downstream can recognize, but a real Vertex / Azure
 * dispatch still needs work outside this bridge — those are rare cases that
 * 3B's migration owns).
 *
 * **Security:** the bridge runs entirely in the main process. The decrypted
 * API key only leaves the registry's encrypted store inside this main-process
 * boundary; it is written to `ProcessConfig` exactly as the legacy
 * `ModelModalContent` flow has always done (plaintext in user-data JSON). No
 * key material crosses the IPC boundary into the renderer.
 */

import { uuid } from '@/common/utils';
import type { IProvider } from '@/common/config/storage';
import type { ProviderId } from '../types';

/**
 * The slice of `ProcessConfig` the bridge needs — declared as a structural
 * type so unit tests can inject an in-memory fake.
 */
export type LegacyConfigStore = {
  get: (key: 'model.config') => Promise<unknown>;
  set: (key: 'model.config', value: IProvider[]) => Promise<void>;
};

/**
 * Bridge surface the IPC handlers call after a successful connect / rekey /
 * disconnect. The two methods are intentionally narrow — the bridge is purely
 * a one-way mirror, never read back by the IPC layer.
 */
export type LegacyModelConfigBridge = {
  /**
   * Mirror a connected provider into `model.config`. `creds` carries either a
   * single API key or a cloud-credential `fields` map. `modelIds` is the
   * provider's full catalog (text + non-text both, since the legacy chat-start
   * also surfaces image/embedding rows from the same provider record); the
   * picker uses `provider.model.includes(useModel)` to resolve the row.
   *
   * Calling twice with the same `providerId` updates the existing row in place;
   * the row's `id` is preserved so legacy default-model references keep working.
   */
  writeProvider: (
    providerId: ProviderId,
    creds: { key: string } | { fields: Record<string, string> },
    modelIds: string[]
  ) => Promise<void>;

  /** Remove a previously-mirrored row. No-op if the row does not exist. */
  removeProvider: (providerId: ProviderId) => Promise<void>;
};

// ─── Provider-id → legacy platform mapping ────────────────────────────────────

/**
 * Map a new-registry `ProviderId` to the legacy `IProvider.platform` string
 * the chat-start dispatch (`wcore/envBuilder.ts` `mapProvider()`) recognizes.
 *
 * Most providers don't have a special `platform` arm in the legacy dispatcher
 * — `mapProvider()` falls through to `'openai'` (OpenAI-compatible protocol).
 * That is the correct behavior for OpenRouter / Groq / Together / Fireworks /
 * etc., so we use a plain `openai-compatible` platform for those — the legacy
 * chat-start treats it as OpenAI-protocol and uses the persisted `baseUrl`.
 *
 * `gemini` is reserved for the Gemini API path that goes through the OpenAI-
 * compatible endpoint (`/v1beta/openai`). Vertex / Bedrock get their own
 * platform string so `mapProvider()` routes them correctly.
 */
const PROVIDER_ID_TO_PLATFORM: Record<ProviderId, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'google-gemini': 'gemini',
  'aws-bedrock': 'bedrock',
  vertex: 'gemini-vertex-ai',
  azure: 'azure',
  // The OpenAI-compatible long tail — all dispatched as the `openai` protocol
  // via their stored `baseUrl`. `mapProvider()` falls through to OpenAI for an
  // unknown platform string, so these reach the right protocol either way; we
  // pick `openai-compatible` to make the legacy row honest about its kind.
  openrouter: 'openai-compatible',
  groq: 'openai-compatible',
  xai: 'openai-compatible',
  mistral: 'openai-compatible',
  cohere: 'openai-compatible',
  perplexity: 'openai-compatible',
  together: 'openai-compatible',
  fireworks: 'openai-compatible',
  cerebras: 'openai-compatible',
  replicate: 'openai-compatible',
  huggingface: 'openai-compatible',
  nvidia: 'openai-compatible',
  anyscale: 'openai-compatible',
  deepseek: 'openai-compatible',
  moonshot: 'openai-compatible',
  qwen: 'openai-compatible',
  baichuan: 'openai-compatible',
  lingyiwanwu: 'openai-compatible',
  'zhipu-glm': 'openai-compatible',
  minimax: 'openai-compatible',
  stability: 'openai-compatible',
  deepgram: 'openai-compatible',
  assemblyai: 'openai-compatible',
  elevenlabs: 'openai-compatible',
  'openai-compatible': 'openai-compatible',
};

/**
 * Map a `ProviderId` to its canonical `baseUrl`. Chat-start (`wcore/envBuilder`)
 * passes this to the underlying CLI verbatim. The values mirror
 * `PROVIDER_ENDPOINTS` (which is the `/v1/models` URL) with the `/models` tail
 * stripped — the chat-start path expects the base path the OpenAI SDK accepts.
 */
const PROVIDER_ID_TO_BASE_URL: Partial<Record<ProviderId, string>> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  'google-gemini': 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  cohere: 'https://api.cohere.com/v1',
  perplexity: 'https://api.perplexity.ai',
  together: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  replicate: 'https://api.replicate.com/v1',
  huggingface: 'https://huggingface.co',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  anyscale: 'https://api.endpoints.anyscale.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  baichuan: 'https://api.baichuan-ai.com/v1',
  lingyiwanwu: 'https://api.lingyiwanwu.com/v1',
  'zhipu-glm': 'https://open.bigmodel.cn/api/paas/v4',
  minimax: 'https://api.minimax.chat/v1',
  stability: 'https://api.stability.ai/v1',
  deepgram: 'https://api.deepgram.com/v1',
  assemblyai: 'https://api.assemblyai.com/v2',
  elevenlabs: 'https://api.elevenlabs.io/v1',
};

/**
 * Short human-readable name shown in any legacy UI that lists `model.config`
 * rows. Kept compact — the new Models page is the canonical surface.
 */
const PROVIDER_ID_TO_NAME: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'google-gemini': 'Google Gemini',
  'aws-bedrock': 'AWS Bedrock',
  vertex: 'Google Vertex',
  azure: 'Azure OpenAI',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  xai: 'xAI',
  mistral: 'Mistral',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  together: 'Together AI',
  fireworks: 'Fireworks AI',
  cerebras: 'Cerebras',
  replicate: 'Replicate',
  huggingface: 'Hugging Face',
  nvidia: 'NVIDIA',
  anyscale: 'Anyscale',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot',
  qwen: 'Qwen',
  baichuan: 'Baichuan',
  lingyiwanwu: 'Lingyi Wanwu',
  'zhipu-glm': 'Zhipu GLM',
  minimax: 'MiniMax',
  stability: 'Stability AI',
  deepgram: 'Deepgram',
  assemblyai: 'AssemblyAI',
  elevenlabs: 'ElevenLabs',
  'openai-compatible': 'OpenAI Compatible',
};

/**
 * Build the `IProvider` row for a Bedrock connect. The legacy chat-start path
 * reads credentials out of `bedrockConfig`, not `apiKey`. Only the access-key
 * auth method is supported here — IAM profile auth requires a richer flow
 * that 3B's full migration will handle.
 */
function buildBedrockRow(
  providerId: ProviderId,
  existing: IProvider | undefined,
  fields: Record<string, string>,
  modelIds: string[]
): IProvider {
  return {
    id: existing?.id ?? uuid(),
    platform: PROVIDER_ID_TO_PLATFORM[providerId],
    name: PROVIDER_ID_TO_NAME[providerId],
    baseUrl: '',
    apiKey: '',
    model: modelIds,
    bedrockConfig: {
      authMethod: 'accessKey',
      region: fields.region ?? '',
      accessKeyId: fields.accessKeyId,
      secretAccessKey: fields.secretAccessKey,
    },
  };
}

/**
 * Build the `IProvider` row for a standard key-based provider. The `baseUrl`
 * defaults to the canonical endpoint for the provider id; the registry never
 * stores a custom base url (Wave 0 contract — `key` is the only field), so
 * the canonical endpoint is always correct.
 */
function buildApiKeyRow(
  providerId: ProviderId,
  existing: IProvider | undefined,
  key: string,
  modelIds: string[]
): IProvider {
  return {
    id: existing?.id ?? uuid(),
    platform: PROVIDER_ID_TO_PLATFORM[providerId],
    name: PROVIDER_ID_TO_NAME[providerId],
    baseUrl: PROVIDER_ID_TO_BASE_URL[providerId] ?? '',
    apiKey: key,
    model: modelIds,
  };
}

/**
 * Tag stamped on the persisted `IProvider` row so a Packet 3B migration (or
 * any future cleanup) can identify rows the bridge owns vs rows the legacy
 * `ModelModalContent` flow created. The tag survives a JSON round-trip because
 * the legacy normalization in `getMergedModelProviders` preserves unknown
 * fields with spread.
 */
const BRIDGE_TAG_KEY = '__waylandModelRegistryBridge';
const BRIDGE_TAG_VALUE = 'v1';

/**
 * Stamp the bridge tag onto an `IProvider` row. The cast goes through
 * `unknown` because the tag is not part of the `IProvider` type — 3B will
 * remove the tag along with the bridge.
 */
function stamp(row: IProvider): IProvider {
  return { ...row, [BRIDGE_TAG_KEY]: BRIDGE_TAG_VALUE } as unknown as IProvider;
}

/**
 * Build a production `LegacyModelConfigBridge` backed by a `ProcessConfig`-
 * shaped store. The factory takes the store as a dependency so the unit test
 * can wire an in-memory fake without the disk-backed config implementation.
 */
export function createLegacyModelConfigBridge(store: LegacyConfigStore): LegacyModelConfigBridge {
  async function readConfig(): Promise<IProvider[]> {
    const data = await store.get('model.config');
    return Array.isArray(data) ? (data as IProvider[]) : [];
  }

  return {
    async writeProvider(providerId, creds, modelIds) {
      // The bridge never fabricates a row for a provider it can't honestly
      // describe — an unknown id is a defensive skip rather than a write.
      if (!PROVIDER_ID_TO_PLATFORM[providerId]) return;

      const list = await readConfig();
      // Match an existing mirrored row by the bridge tag — the bridge only
      // ever owns one row per provider id. An untagged row with the same
      // `platform` is the user's legacy `ModelModalContent` row, NOT the
      // bridge's; leave it alone and add a new tagged row beside it. (3B's
      // one-time migration will reconcile the two.)
      const platform = PROVIDER_ID_TO_PLATFORM[providerId];
      const existing = list.find(
        (p) => p.platform === platform && (p as unknown as Record<string, unknown>)[BRIDGE_TAG_KEY] === BRIDGE_TAG_VALUE
      );

      let row: IProvider;
      if (providerId === 'aws-bedrock') {
        if (!('fields' in creds)) return; // bedrock requires a fields payload
        row = buildBedrockRow(providerId, existing, creds.fields, modelIds);
      } else if (providerId === 'vertex' || providerId === 'azure') {
        // Vertex / Azure mirror — `apiKey` and `baseUrl` are left empty; 3B's
        // migration owns the full credential shape. The row exists primarily
        // so the home picker resolves to it and surfaces a chat-start error
        // instead of silently dropping the click.
        if (!('fields' in creds)) return;
        row = {
          id: existing?.id ?? uuid(),
          platform: PROVIDER_ID_TO_PLATFORM[providerId],
          name: PROVIDER_ID_TO_NAME[providerId],
          baseUrl: creds.fields.endpoint ?? '',
          apiKey: creds.fields.apiKey ?? '',
          model: modelIds,
        };
      } else {
        if (!('key' in creds)) return; // standard providers require a key
        row = buildApiKeyRow(providerId, existing, creds.key, modelIds);
      }

      const stamped = stamp(row);
      const next = existing ? list.map((p) => (p.id === existing.id ? stamped : p)) : [...list, stamped];
      await store.set('model.config', next);
    },

    async removeProvider(providerId) {
      const platform = PROVIDER_ID_TO_PLATFORM[providerId];
      if (!platform) return;
      const list = await readConfig();
      // Remove ONLY rows the bridge owns (stamped with our tag) for this
      // platform. A row created by the legacy `ModelModalContent` flow shares
      // the same `platform` value but is NOT owned by us — leaving it alone
      // honors the "registry and legacy coexist" rule for Wave 3A.
      const next = list.filter((p) => {
        const tagged = (p as unknown as Record<string, unknown>)[BRIDGE_TAG_KEY] === BRIDGE_TAG_VALUE;
        return !(p.platform === platform && tagged);
      });
      if (next.length !== list.length) {
        await store.set('model.config', next);
      }
    },
  };
}

/** A no-op bridge — used in unit tests that don't care about the legacy write-through. */
export const noopLegacyBridge: LegacyModelConfigBridge = {
  writeProvider: async () => {},
  removeProvider: async () => {},
};
