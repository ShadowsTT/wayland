/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { getMergedModelProviders } from '@process/bridge/modelBridge';
import type { IProvider } from '@/common/config/storage';
import { googleAuthGeminiComplete, isGoogleAuthGeminiAvailable } from './geminiOAuth';

/**
 * A minimal one-shot LLM completion for cheap background tasks (e.g. the project
 * knowledge one-liner summary). It deliberately does NOT go through the
 * conversation engine: it picks the cheapest fast model the user already has a
 * key for and makes a single stateless call.
 *
 * Model selection is by name heuristic (haiku / mini / flash / nano / lite …)
 * rather than the provider-keyed classifier, so it works regardless of how the
 * provider labels itself. Routing is by endpoint host, not platform label, so a
 * Claude model served through an OpenAI-compatible proxy is still hit correctly.
 */

const FETCH_TIMEOUT_MS = 20_000;

/** Name fragments that indicate a small/cheap/fast model, best first. */
const FAST_HINTS = [
  /haiku/i,
  /flash-lite/i,
  /flash/i,
  /gpt-4o-mini/i,
  /gpt-5-mini/i,
  /[-_]mini\b/i,
  /[-_]nano\b/i,
  /[-_]lite\b/i,
  /[-_]small\b/i,
  /\b8b\b/i,
  /turbo/i,
];

export type PickedModel = { provider: IProvider; modelId: string };

type Endpoint = { flavor: 'anthropic' | 'gemini' | 'openai'; base: string };

/**
 * Resolve how to call a provider, by platform (the authoritative signal) with
 * canonical endpoint defaults - many providers store an empty baseUrl and rely
 * on the platform default. Returns null when we cannot reliably reach it (a
 * generic openai-compatible provider with no baseUrl has no known endpoint), so
 * such providers are simply skipped rather than mis-called.
 */
const resolveEndpoint = (p: IProvider): Endpoint | null => {
  const platform = (p.platform || '').toLowerCase();
  const baseUrl = (p.baseUrl || '').trim();
  if (platform.includes('anthropic') || platform.includes('claude') || p.apiKey?.startsWith('sk-ant-')) {
    return { flavor: 'anthropic', base: baseUrl || 'https://api.anthropic.com' };
  }
  if (platform.includes('gemini') || platform.includes('google') || baseUrl.includes('generativelanguage')) {
    return { flavor: 'gemini', base: baseUrl || 'https://generativelanguage.googleapis.com' };
  }
  if (platform === 'openai') {
    return { flavor: 'openai', base: baseUrl || 'https://api.openai.com/v1' };
  }
  // openai-compatible (groq, byok proxies, etc.): only reachable with an explicit baseUrl.
  if (baseUrl) return { flavor: 'openai', base: baseUrl };
  return null;
};

const usableModels = (providers: IProvider[]): PickedModel[] => {
  const out: PickedModel[] = [];
  for (const p of providers) {
    if (p.enabled === false) continue;
    if (!p.apiKey || !p.apiKey.trim()) continue; // needs a key to call
    if (!resolveEndpoint(p)) continue; // no reachable endpoint - skip
    const models = Array.isArray(p.model) ? p.model : [];
    for (const modelId of models) {
      if (p.modelEnabled && p.modelEnabled[modelId] === false) continue;
      out.push({ provider: p, modelId });
    }
  }
  return out;
};

const fastRank = (modelId: string): number => {
  for (let i = 0; i < FAST_HINTS.length; i++) {
    if (FAST_HINTS[i].test(modelId)) return i;
  }
  return FAST_HINTS.length; // not a known-fast model - lowest preference
};

/** Name fragments that indicate a flagship / most-capable model, best first. */
const BEST_HINTS = [
  /opus/i,
  /gpt-5\.\d/i,
  /gpt-5/i,
  /sonnet/i,
  /gemini-[\d.]*-?pro/i,
  /[-_]pro\b/i,
  /gpt-4\.1/i,
  /gpt-4o(?!-mini)/i,
  /[-_]large\b/i,
];

const bestRank = (modelId: string): number => {
  for (let i = 0; i < BEST_HINTS.length; i++) {
    if (BEST_HINTS[i].test(modelId)) return i;
  }
  return BEST_HINTS.length; // not a known-flagship model
};

/** Pick the cheapest fast model the user has a usable key for, or null. */
export async function pickCheapestFastModel(): Promise<PickedModel | null> {
  const providers = await getMergedModelProviders();
  const candidates = usableModels(providers);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => fastRank(a.modelId) - fastRank(b.modelId));
  return candidates[0];
}

/**
 * Pick the most capable model the user has a usable key for (for high-stakes,
 * rarely-run drafting like the knowledge wizard). Prefers known flagships by
 * name; when none match, de-prioritizes the obviously-cheap/fast models so a
 * more capable default wins.
 */
export async function pickBestModel(): Promise<PickedModel | null> {
  const providers = await getMergedModelProviders();
  const candidates = usableModels(providers);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const rb = bestRank(b.modelId);
    const ra = bestRank(a.modelId);
    if (ra !== rb) return ra - rb; // known flagship first
    return fastRank(b.modelId) - fastRank(a.modelId); // tie: prefer the less-cheap (more capable) one
  });
  return candidates[0];
}

/** True if any configured model can be called (used to enable the UI affordance). */
export async function hasUsableModel(): Promise<boolean> {
  if ((await pickCheapestFastModel()) !== null) return true;
  // Google-auth users have no keyed model but can still complete via OAuth Gemini.
  return isGoogleAuthGeminiAvailable();
}

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const joinUrl = (base: string, suffix: string): string => `${base.replace(/\/+$/, '')}${suffix}`;

/**
 * Read a JSON response body defensively: pull the body as text first, then check
 * the status before parsing. Non-2xx responses with a non-JSON/HTML body (a
 * Cloudflare/nginx 502, a 404 page, an auth/login redirect) would otherwise make
 * `res.json()` throw an opaque "Unexpected token '<'" SyntaxError that masks the
 * real HTTP failure. This surfaces a clear "<status>: <message>" when the body is
 * a JSON error, and a clear HTTP error otherwise.
 */
const parseJsonResponse = async <T>(res: Response): Promise<T> => {
  const text = await res.text();
  let data: T | undefined;
  try {
    data = text ? (JSON.parse(text) as T) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } } | undefined)?.error?.message;
    if (msg) throw new Error(`${res.status}: ${msg}`);
    throw new Error(`Provider returned HTTP ${res.status} (non-JSON response)`);
  }
  if (data === undefined) throw new Error(`Provider returned HTTP ${res.status} (non-JSON response)`);
  return data;
};

/**
 * Make a single completion call. Routes by endpoint host so a Claude/Gemini
 * model served via an OpenAI-compatible proxy is still called the right way.
 */
export async function oneShotComplete(
  prompt: string,
  opts?: { maxTokens?: number; model?: PickedModel; timeoutMs?: number }
): Promise<string> {
  const picked = opts?.model ?? (await pickCheapestFastModel());
  if (!picked) {
    // No keyed model. Fall back to Google-auth Gemini for users who connected via
    // "Continue with Google" (the primary onboarding path): they have no API key,
    // so the key-based provider scan never surfaces their Gemini models.
    if (isGoogleAuthGeminiAvailable()) {
      return googleAuthGeminiComplete(prompt, { maxTokens: opts?.maxTokens, timeoutMs: opts?.timeoutMs });
    }
    throw new Error('no-usable-model');
  }
  const { provider, modelId } = picked;
  const endpoint = resolveEndpoint(provider);
  if (!endpoint) throw new Error('no-usable-model');
  const maxTokens = opts?.maxTokens ?? 160;
  const timeoutMs = opts?.timeoutMs;
  const { flavor, base } = endpoint;

  if (flavor === 'anthropic') {
    const res = await fetchWithTimeout(
      joinUrl(base, '/v1/messages'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01',
          'User-Agent': 'Wayland/1.0',
        },
        body: JSON.stringify({ model: modelId, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
      },
      timeoutMs
    );
    const data = await parseJsonResponse<{ content?: Array<{ text?: string }>; error?: { message?: string } }>(res);
    return (data.content?.[0]?.text || '').trim();
  }

  if (flavor === 'gemini') {
    const url = joinUrl(base, `/v1beta/models/${modelId}:generateContent?key=${provider.apiKey}`);
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Wayland/1.0' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      },
      timeoutMs
    );
    const data = await parseJsonResponse<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message?: string };
    }>(res);
    return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  }

  // OpenAI-compatible
  const res = await fetchWithTimeout(
    joinUrl(base, '/chat/completions'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
        'User-Agent': 'Wayland/1.0',
      },
      body: JSON.stringify({ model: modelId, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    },
    timeoutMs
  );
  const data = await parseJsonResponse<{
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  }>(res);
  return (data.choices?.[0]?.message?.content || '').trim();
}
