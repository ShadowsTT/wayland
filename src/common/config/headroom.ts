/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Headroom is a *local, transparent Anthropic-wire proxy*: it accepts the same
 * `/v1/messages` traffic the Anthropic SDK and the claude CLI already emit,
 * compresses + forwards it upstream using the caller's OWN credentials, and
 * returns the real response. Routing Wayland through it therefore means one
 * thing only: override the Anthropic base URL to point at the local proxy,
 * WITHOUT touching auth (the native ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is
 * passed straight through).
 *
 * This is the OPPOSITE of the Flux surface (see `flux.ts` / `fluxRouting.ts`),
 * which swaps in a hosted gateway + its own minted key + the `flux-auto` model.
 * The two cannot both sit in front of a single request, so they are mutually
 * exclusive: enabling one disables the other (enforced in systemSettingsBridge
 * and surfaced in the settings UI).
 */

/** Where the Headroom proxy listens by default when started locally. */
export const HEADROOM_DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';

/**
 * Backends whose spawned CLI speaks the Anthropic wire protocol and therefore
 * honors `ANTHROPIC_BASE_URL` — the only backends a Headroom (Anthropic) proxy
 * can transparently sit in front of. codex/qwen/gemini use OpenAI/Gemini
 * surfaces Headroom does not serve, so they are never routed through it.
 */
const HEADROOM_ROUTABLE_BACKENDS = new Set<string>(['claude']);

/** True when `backend`'s CLI is Anthropic-wire and thus Headroom-routable. */
export function isHeadroomRoutableBackend(backend: string): boolean {
  return HEADROOM_ROUTABLE_BACKENDS.has(backend);
}

/**
 * Resolve the effective Headroom endpoint: a user-configured value when it is a
 * non-empty string, else the default local proxy. Trailing slashes are trimmed
 * so callers can safely append `/v1/messages`.
 */
export function resolveHeadroomEndpoint(configured?: string | null): string {
  const trimmed = typeof configured === 'string' ? configured.trim() : '';
  const endpoint = trimmed.length > 0 ? trimmed : HEADROOM_DEFAULT_ENDPOINT;
  return endpoint.replace(/\/+$/, '');
}

/** Loose validation for the user-entered endpoint: must be an http(s) URL. */
export function isValidHeadroomEndpoint(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
