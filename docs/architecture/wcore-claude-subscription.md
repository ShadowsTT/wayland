# Driving a Claude Pro/Max subscription through the Wayland Core engine

**Status:** desktop wiring staged & inert; **blocked on an engine change** in
[`FerroxLabs/wayland-core`](https://github.com/FerroxLabs/wayland-core).

This document is the contract for making a Claude **subscription** (OAuth, Pro/Max)
drive inference through the bundled `wayland-core` engine, exactly the way a ChatGPT
subscription already does via `--provider openai-chatgpt`. It is written so the
engine change can be implemented against a fixed desktop-side interface.

---

## Why this is needed

The desktop already signs a user in with their Claude Pro/Max subscription (the same
public OAuth client Claude Code uses) and stores the token. Today that subscription
can only be used through the **Claude Code ACP agent** — not the Wayland Core engine —
because:

- A subscription OAuth token **cannot be used as an Anthropic API key**. It must be
  presented as `Authorization: Bearer <token>` **plus** an `anthropic-beta:
oauth-2025-04-20` header, against the native Messages API (`/v1/messages`).
- The bundled engine (`wayland-core` ≤ 0.12.24) implements Anthropic only in
  **API-key** mode (`x-api-key` / `ANTHROPIC_API_KEY`). Inspecting the shipped binary:
  `oauth-2025-04-20` → **0** occurrences, `claude-subscription` → **0**,
  `.credentials.json` → **0**; whereas `openai-chatgpt` → 16 and `codex/auth.json` → 1.
  So the ChatGPT-OAuth path is baked in, the Claude-OAuth path is not.

Routing the subscription token to the existing `--provider anthropic` slug therefore
fails (the token is sent as an `x-api-key` and rejected). The fix is a new engine
provider that mirrors `openai-chatgpt`, but for Anthropic OAuth.

---

## The ChatGPT precedent (what to mirror)

| Concern                          | ChatGPT subscription (shipping)                            | Claude subscription (this contract)                              |
| -------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| Engine `--provider` slug         | `openai-chatgpt`                                           | **`anthropic-claude`**                                           |
| Credential file the engine reads | `~/.codex/auth.json` (honors `$CODEX_HOME`)                | **`~/.claude/.credentials.json`** (honors `$CLAUDE_CONFIG_DIR`)  |
| Auth on requests                 | ChatGPT backend OAuth                                      | **`Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`** |
| Endpoint                         | `chatgpt.com/backend-api` (engine-owned)                   | **`https://api.anthropic.com/v1/messages`** (engine-owned)       |
| Desktop emits                    | `--provider openai-chatgpt` only (no key, no `--base-url`) | **`--provider anthropic-claude` only (no key, no `--base-url`)** |
| Token refresh                    | engine refreshes & rewrites the file                       | **engine refreshes & rewrites the file**                         |

---

## Engine contract (what `wayland-core` must implement)

### 1. New provider slug: `anthropic-claude`

`wayland-core --provider anthropic-claude --model <claude-model-id> --json-stream`

- Owns the host — ignores any `--base-url`; targets `https://api.anthropic.com`.
- Requires **no** `--api-key` / `ANTHROPIC_API_KEY`. The credential comes from the file below.

### 2. Read the credential file

Path: `$CLAUDE_CONFIG_DIR/.credentials.json` if `CLAUDE_CONFIG_DIR` is set and non-blank,
else `~/.claude/.credentials.json`. This is the **standard Claude Code store** and is
already written by the desktop (`writeClaudeCredentialsFile`). Shape (read the nested
`claudeAiOauth` object):

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-…",
    "refreshToken": "sk-ant-ort01-…",
    "expiresAt": 1784638574523,
    "scopes": ["user:inference", "user:profile", "…"],
    "subscriptionType": "max"
  }
}
```

- `accessToken` is REQUIRED. `expiresAt` is epoch **ms**.
- Fail cleanly (surface an auth error the host can show) when the file is absent,
  malformed, or holds no `accessToken`.

### 3. Authenticate every inference request

Send to `POST https://api.anthropic.com/v1/messages`:

- `Authorization: Bearer <accessToken>` — **not** `x-api-key`.
- `anthropic-version: 2023-06-01`
- `anthropic-beta: oauth-2025-04-20` (append to any existing beta list, comma-joined)
- `content-type: application/json`

> **Critical — the Claude Code identity system prompt.** Anthropic accepts a
> subscription OAuth token for inference **only when the request presents as Claude
> Code**. The engine MUST prepend a system prompt block whose first line is exactly:
>
> `You are Claude Code, Anthropic's official CLI for Claude.`
>
> (This is how the Claude Code CLI itself is authorized; omitting it yields a
> `401`/`invalid` "this token is only valid for Claude Code" style rejection.) The
> engine's normal system prompt / persona can follow this block.

### 4. Token refresh + write-back

When `expiresAt` is within a small skew (≈ 5 min) or a request returns `401`:

- `POST https://console.anthropic.com/v1/oauth/token`
  with body `grant_type=refresh_token`, `refresh_token=<refreshToken>`,
  `client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e` (public PKCE client; overridable).
- On success, **rewrite** `~/.claude/.credentials.json` with the new
  `accessToken`/`refreshToken`/`expiresAt` (dir `0o700`, file `0o600`, atomic
  temp+rename — same discipline the desktop uses), preserving `refreshToken`/`scopes`/
  `subscriptionType` when the response omits them. This keeps the desktop and Claude
  Code CLI in sync.

### 5. (Optional) model listing

`GET https://api.anthropic.com/v1/models` with the same Bearer + beta headers returns
the account's model list. The desktop already lists models this way; the engine's
`models` subcommand may mirror it but is not required for inference.

---

## Desktop side (already implemented in this repo, gated OFF)

All of this is in place behind a single flip-switch — no further desktop work is needed
to turn it on once the engine ships:

- `src/process/agent/wcore/envBuilder.ts`
  - `CLAUDE_SUBSCRIPTION_ENGINE_PROVIDER = 'anthropic-claude'` (added to the
    `NativeWCoreProvider` union).
  - `CLAUDE_SUBSCRIPTION_ENGINE_ENABLED` — **the flip-switch** (currently `false`).
  - `isClaudeSubscription(model)` — matches the `v2:claude-subscription` bridge tag.
  - `mapProvider` routes a subscription model to `anthropic-claude` **only** when the
    ready signal is set; otherwise falls through unchanged (inference stays on the
    Claude Code ACP agent).
  - `buildSpawnConfig` emits `--provider anthropic-claude` with **no** key env var and
    **no** `--base-url` (mirrors the `openai-chatgpt` case).
- `src/process/agent/wcore/index.ts` — reads `~/.claude/.credentials.json` for the
  availability signal (only when the flip-switch is on, so there is zero extra I/O
  while disabled) and threads it into `buildSpawnConfig`.
- The credential file writer/reader already exist:
  `src/process/onboarding/claudeCredentialsFile.ts`
  (`writeClaudeCredentialsFile` / `readClaudeCredentialsFile`).
- OAuth constants live in `src/process/onboarding/anthropicOAuthCore.ts`
  (client id, `console.anthropic.com/v1/oauth/token`, scopes incl. `user:inference`).

### Turning it on

1. Ship a `wayland-core` release implementing §1–§4 above.
2. Bump the bundled engine (`resources/bundled-wayland-core/**/manifest.json`).
3. Set `CLAUDE_SUBSCRIPTION_ENGINE_ENABLED = true` (or, if a minimum engine version
   guard is preferred, gate it on the detected engine version in `wcore/index.ts`).
4. That's it — a user signed in with their Claude subscription can then select a Claude
   model under the **Wayland Core** engine and it works keylessly.

---

## Acceptance criteria

- With a valid `~/.claude/.credentials.json` present and the flag on, selecting a
  `claude-*` subscription model under Wayland Core spawns
  `wayland-core --json-stream --provider anthropic-claude --model <id>` with **no**
  `ANTHROPIC_API_KEY` and **no** `--base-url`, and a turn completes.
- A near-expiry token is refreshed by the engine and written back to the credential
  file (the desktop/CLI pick up the new token on their next read).
- With the flag **off** (today's default), behavior is byte-for-byte unchanged and no
  extra credential-file read occurs.
- A normal Anthropic **API-key** model (no `v2:claude-subscription` tag) still routes
  to `--provider anthropic` with `ANTHROPIC_API_KEY` — the staged arm never hijacks it.

> **Caveat, surfaced honestly:** Anthropic actively restricts subscription-OAuth use
> inside third-party tools and may reject a turn even when sign-in succeeded. The engine
> must surface such rejections as recoverable auth failures (the desktop already has the
> ACP auth-failure recovery card for the Claude Code path).
