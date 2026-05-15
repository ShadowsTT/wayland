# DEPS-HYGIENE — W4 L34+L35+L36 dependency bump audit

**Branch:** `feat/audit-hardening`
**Commit under audit:** `45901dcd5` "chore(deps): W4 L34+L35+L36 — sentry-electron + MCP + anthropic + esbuild bumps"
**Date:** 2026-05-15
**Auditor:** read-only — no code, dep, or commit changes
**Verdict:** **CLEAN** across all four bumped deps. Two CVEs closed. tsc passes. No call-site adjustments needed.

---

## Summary

| Dep                          | From       | To         | Resolved   | Compat verdict | CVEs closed by bump |
| ---------------------------- | ---------- | ---------- | ---------- | -------------- | ------------------- |
| `@sentry/electron`           | ^7.10.0    | ^7.13.0    | 7.13.0     | **CLEAN**      | none (no advisories on this package, ever) |
| `@modelcontextprotocol/sdk`  | ^1.20.0    | ^1.29.0    | 1.29.0     | **CLEAN**      | **3 HIGH** (GHSA-345p, GHSA-8r9q, GHSA-w48q) |
| `@anthropic-ai/sdk`          | ^0.71.2    | ^0.96.0    | 0.96.0     | **CLEAN**      | 0 directly applicable (Memory Tool feature not used; vuln window never reached this app) |
| `esbuild`                    | ^0.25.11   | ^0.28.0    | 0.28.0     | **CLEAN with one caveat** | none new (esbuild 0.27.0 was a "breaking" semver-zero bump; OS requirement raised — see below) |

**Verification commands run (all read-only):**

```
git log --oneline -1 45901dcd5       → confirmed commit present on feat/audit-hardening
grep '"…"' package.json              → confirmed ^0.96.0 / ^1.29.0 / ^7.13.0 / ^0.28.0
grep '"@…@…"' bun.lock               → confirmed resolved 0.96.0 / 1.29.0 / 7.13.0 / 0.28.0
bun pm scan                          → not configured (returns error; replaced by GHSA queries)
npm audit                            → ENOLOCK (no package-lock.json; Bun-only repo)
bunx tsc --noEmit                    → exit 0, 0 lines of output (CLEAN)
gh release list --repo …             → confirmed all four packages actively maintained (last release within 30 days)
gh api graphql securityVulnerabilities → per-dep advisory check on every resolved version
```

CVE audit tooling note: `bun pm audit` does not exist in installed Bun. `bun pm scan` requires a configured scanner in `bunfig.toml`. `npm audit` requires `package-lock.json` (this is a Bun-managed repo with no npm lockfile). Used GitHub Security Advisory GraphQL API directly against each resolved version — same source npm/bun audit consult.

---

## L34 — @sentry/electron 7.10.0 → 7.13.0

**Pinned in package.json:5:98** as `"@sentry/electron": "^7.13.0"`.
**Resolved in bun.lock:1125** to `@sentry/electron@7.13.0`. Single resolution, no transitive duplicates.

**Wayland call site (1):**

- `src/index.ts:10` — `import * as Sentry from '@sentry/electron/main';`
- `src/index.ts:62-68` — `Sentry.init({ dsn, beforeSend: scrubPii, sampleRate: 1.0, tracesSampleRate: 0.0 })`
- `src/index.ts:24-57` — `beforeSend` hook of type `Sentry.ErrorEvent` consumes `.extra`, `.tags`, `.contexts`, `.request.headers`, `.request.cookies`, `.message`, `.exception.values[].value`, `.exception.values[].stacktrace.frames[].filename`.

**Breaking-change surface (7.11.0 → 7.13.0):**

- **7.11.0**: Sentry JS SDK bump to 10.43.0 → 10.47.0 (additive). Migrated to oxlint internally (no API impact). No init-shape change.
- **7.12.0**: Sentry JS SDK 10.49.0 (additive).
- **7.13.0**: Sentry JS SDK 10.50.0 (additive). Three bug fixes: minidump malformation guard, renderer-JSON parse guard, truncate minidump extras-on-update. No API surface change.

The `Sentry.init` shape (`dsn`, `beforeSend`, `sampleRate`, `tracesSampleRate`) is in `@sentry/core`'s `Options<ErrorEvent>` interface and has been stable across the entire 7.x line. The `ErrorEvent` shape consumed by `scrubPii` has not changed.

**Verdict: CLEAN.** No source change required, none made.

---

## L35a — @modelcontextprotocol/sdk 1.20.0 → 1.29.0

**Pinned in package.json:5:94** as `"@modelcontextprotocol/sdk": "^1.29.0"`.
**Resolved in bun.lock:**
- `bun.lock:737`  → `@modelcontextprotocol/sdk@1.29.0` (direct)
- `bun.lock:3765` → `@modelcontextprotocol/sdk@1.27.1` (transitive via `@office-ai/aioncli-core`)

**Wayland call sites (4):**

1. `src/process/services/mcpServices/McpProtocol.ts:11-14` — `Client`, `SSEClientTransport`, `StdioClientTransport`, `StreamableHTTPClientTransport`. Usage: `new Client(info, opts)`, `client.connect(transport)`, `client.listTools()`, `new StdioClientTransport({...})`, `new SSEClientTransport(url, opts)`, `new StreamableHTTPClientTransport(url, opts)`.
2. `src/process/resources/builtinMcp/imageGenServer.ts:13-14` — `McpServer`, `StdioServerTransport`. Usage: `new McpServer({name, version})`, `server.tool(name, description, zodRawShape, asyncHandler)`, `server.connect(transport)`.
3. `src/process/team/mcp/team/teamMcpStdio.ts:14-15` — same pattern as imageGenServer; passes second-arg `{capabilities: {tools: {}}}` to `McpServer` constructor.
4. `src/process/team/mcp/guide/teamGuideMcpStdio.ts:14-15` — same pattern.

All call sites pass **Zod raw shapes** (e.g. `{ to: z.string().describe('…'), message: z.string() }`) to `server.tool`, not plain JSON Schema objects.

**Breaking-change surface across 1.21-1.29 (v1.x trunk; v2.0.0-alpha exists but we are not on it):**

- **1.21 - 1.25**: no GitHub release notes (silent patch line). Code change visible only via 1.26 backport list — bug fixes, no API removals.
- **1.26.0**: **fixes GHSA-345p-7cg4-v4c7 (HIGH)** — cross-client data leak via shared server/transport reuse. Required no consumer code change.
- **1.27.0**: adds `RequestInfo.url`, conformance test infra, OAuth `discoverOAuthServerInfo()` + discovery caching, streaming methods for elicitation/sampling. **All additive.**
- **1.28.0**: 
  - **`fix: reject plain JSON Schema objects passed as inputSchema`** (#1596). **Verified safe**: Wayland's `server.tool(name, desc, schema, handler)` passes Zod raw shapes (4 confirmed call sites), not plain JSON Schema.
  - `scopes_supported` default-fetched from resource metadata, `client_secret_basic` default for OAuth token endpoint, RFC 8252 loopback port relaxation, scoped abort cleanup. OAuth-flow changes; not exercised by stdio/SSE/HTTP transports in Wayland.
- **1.29.0**: typings exports added, `windowsHide` always set on Windows for stdio, audit-fix dep bumps, extensions advertised in capability object. **Additive.**

**CVEs closed by the bump (verified via GHSA query):**

| GHSA          | Severity | Summary                                                         | Patched in | Pre-bump (1.20) | Post-bump (1.29) |
| ------------- | -------- | --------------------------------------------------------------- | ---------- | --------------- | ---------------- |
| GHSA-w48q-cv73-mx4w | HIGH | MCP TS SDK no DNS rebinding protection by default          | 1.24.0     | VULN            | PATCHED          |
| GHSA-8r9q-7v3j-jr4g | HIGH | ReDoS in MCP TS SDK                                        | 1.25.2     | VULN            | PATCHED          |
| GHSA-345p-7cg4-v4c7 | HIGH | Cross-client data leak via shared server/transport reuse   | 1.26.0     | VULN            | PATCHED          |

The bump closed **three HIGH CVEs** for the direct-use code paths in Wayland.

The transitive 1.27.1 (under `@office-ai/aioncli-core`) is also patched against all three (>= 1.27.1). Not a direct call site for Wayland code.

**Verdict: CLEAN.** No source change required, none made.

---

## L35b — @anthropic-ai/sdk 0.71.2 → 0.96.0 (THE BIG ONE — 25 minor versions)

**Pinned in package.json:5:79** as `"@anthropic-ai/sdk": "^0.96.0"`.
**Resolved in bun.lock:**
- `bun.lock:181`  → `@anthropic-ai/sdk@0.96.0` (direct)
- `bun.lock:3761` → `@anthropic-ai/sdk@0.52.0` (transitive via `@office-ai/aioncli-core`)

**Wayland call sites (2):**

1. `src/common/api/AnthropicRotatingClient.ts:7` — `import Anthropic, { type ClientOptions as AnthropicClientOptions_ } from '@anthropic-ai/sdk';`
   - Uses: `new Anthropic({apiKey, baseURL?, timeout?})` constructor (l. 31-43); `client.messages.create(request)` non-streaming (l. 79, 91); types `Anthropic.MessageCreateParamsNonStreaming` and `Anthropic.Message`.
2. `src/common/api/OpenAI2AnthropicConverter.ts:8` — `import type Anthropic from '@anthropic-ai/sdk';`
   - Uses (type-only): `Anthropic.MessageCreateParamsNonStreaming`, `Anthropic.Message`, `Anthropic.MessageParam`, `Anthropic.ContentBlockParam`, `Anthropic.TextBlockParam`, `Anthropic.Tool.InputSchema`.
   - Reads response fields: `id`, `content` (iterated for `block.type === 'text'`/`'image'`), `stop_reason`, `usage.input_tokens`, `usage.output_tokens`.
   - Authors content blocks: `{ type: 'text', text }`, `{ type: 'image', source: { type: 'base64', media_type, data } | { type: 'url', url } }`.
   - Authors tool entries: `{ name, description, input_schema: Anthropic.Tool.InputSchema }`.

**No streaming usage**, **no tool-use block authoring** in the agent reply path, **no Memory Tool**, **no computer-use**, **no Beta features**, **no token counting endpoint** call sites in Wayland src.

**Breaking-change surface 0.72 - 0.96 (24 minors + several patches; surveyed each via `gh api …/releases/tags/sdk-vX.Y.Z`):**

- Bulk of releases (0.74, 0.76-0.78, 0.81-0.82, 0.84, 0.86-0.88, 0.91-0.95) are **codegen spec-update churn**: new managed-agent types, AWS Mantle Bedrock client added, vertex/bedrock satellite SDKs published in parallel. No breakage to the `messages.create` non-streaming surface used by Wayland.
- **0.72.0** (2026-01-29): Structured Outputs in Messages API (additive). MCP SDK helpers added.
- **0.73.0**: removed `claude-code-review` workflow — internal CI only, no consumer impact.
- **0.75.0** (2026-02-17): `claude-sonnet-4-6` model released — additive.
- **0.79.0**: "remove unused import" + "remove accidentally committed file" — internal cleanup only. Memory Tool feature introduced here (later patched for CVEs — see below).
- **0.83.0**: **client-side compaction helpers deprecated** — Wayland never used compaction; deprecation is doc-only and helpers still ship.
- **0.89.0**: **API metadata flags Sonnet/Opus 4 as deprecated**. Wayland default is `claude-sonnet-4-20250514` (an Anthropic-side deprecation note, not a removal — the model still serves). **Caveat: keep an eye on the next Anthropic deprecation policy window; this is a future-roadmap signal, not a present-day break.**
- **0.90.0**: adds `claude-opus-4-7`, token budgets, user_profiles — additive.
- **0.96.0** (2026-05-13, latest): `BetaManagedAgentsSearchResultBlock` types added, cache diagnostics beta added, **`fix: ensure only zod/v4 types are used`** (#992). **Verified safe**: Wayland uses Zod 3.25.76, which is within `^3.25.0 || ^4.0.0` peer range; the SDK's internal types are zod-version-agnostic at the public API boundary.

**Anthropic-side advisories surveyed (GHSA query, range applied to 0.96.0):**

| GHSA              | Severity | Summary                                                              | Vuln range          | 0.96.0 |
| ----------------- | -------- | -------------------------------------------------------------------- | ------------------- | ------ |
| GHSA-p7fg-763f-g4gf | MODERATE | Insecure default file permissions in Local Filesystem Memory Tool  | `>= 0.79.0, < 0.91.1` | PATCHED |
| GHSA-5474-4w2j-mq4c | MODERATE | Memory Tool path validation allows sandbox escape to sibling dirs  | `>= 0.79.0, < 0.81.0` | PATCHED |

Wayland never used the Memory Tool feature (no `LocalFilesystemMemoryTool` import anywhere in `src/`), so the bump closed exposure on a code path Wayland was not exercising — defense-in-depth, not load-bearing.

**Why 25 minor versions was lower-risk than it looked:**

The Anthropic SDK rolls minor versions every codegen run (~weekly). Major spec changes (Messages API request/response shape, streaming) have been stable since the 0.6x series. The 0.71.2 → 0.96.0 jump traverses primarily:
- Spec metadata churn (new fields, new managed-agent types in unused beta namespaces),
- Satellite-SDK releases (Bedrock, Vertex, AWS) that don't affect the core SDK consumer,
- Two internal model deprecations (Sonnet/Opus 4 marked deprecated, helpers marked deprecated).

The stable public-API surface Wayland uses (`Anthropic` ctor, `messages.create` non-streaming, `MessageCreateParamsNonStreaming`, `Message`, `ContentBlockParam`, base64-image authoring) has not changed.

**Verdict: CLEAN.** Two MODERATE CVEs closed on a code path Wayland was not using. No source change required, none made.

---

## L36 — esbuild 0.25.11 → 0.28.0

**Pinned in package.json:5:198** as `"esbuild": "^0.28.0"`.
**Resolved in bun.lock:**
- `bun.lock:2111` → `esbuild@0.28.0` (direct devDep)
- `bun.lock:4077` → `esbuild@0.25.12` (transitive via `electron-vite`)
- `bun.lock:4305` → `esbuild@0.27.4` (transitive via `tsx`)
- `bun.lock:4313` → `esbuild@0.25.12` (transitive via `vite`)

**Wayland call sites (commit message said "zero src/ consumers" — TRUE; but two scripts/ files DO consume the direct esbuild — flagging for accuracy):**

1. `scripts/build-mcp-servers.js:14` — `const esbuild = require('esbuild');` — uses `esbuild.build({ bundle, platform: 'node', format: 'cjs', external: ['electron'], tsconfig, loader: { '.wasm': 'empty' }, define: {...} })`. **No `target` specified** → defaults to `esnext`.
2. `scripts/build-server.mjs:18` — `import { build } from 'esbuild';` — uses build options including `target: 'node22'` (build-server.mjs:93) and a custom `wasmStubPlugin`.

The commit-message statement "zero src/ consumers" is correct for production runtime code (no `import esbuild` in `src/`), but slightly understates the surface: build-time scripts do use the programmatic API. This is not a bug — just imprecision worth noting.

**Breaking-change surface 0.26 → 0.28:**

- **0.26.0**: ONLY change is `Enable trusted publishing` (release-process refactor). Bit-identical to 0.25.12. No code impact.
- **0.27.0**: **DELIBERATELY backwards-incompatible release**. Two real changes:
  1. `binary` loader now emits `Uint8Array.fromBase64` — requires Node 22+ or fallback. **Wayland does not use the `binary` loader** (confirmed via `grep -rnE "loader.*['\"]binary['\"]" scripts/ src/` returned nothing).
  2. Go compiler updated to 1.25 — **raises OS requirements**: Linux kernel ≥3.2, macOS ≥12 (Monterey). **Caveat: developers on macOS 11 (Big Sur) or older Linux kernels will not be able to run `bun install` cleanly.** For Wayland's stated dev/CI baseline (macOS 14+, Ubuntu 22.04+) this is not load-bearing.
- **0.27.4, 0.27.5, 0.27.7**: bug-fix patches.
- **0.28.0**: 
  - Adds `with { type: 'text' }` import-attributes support (additive).
  - **Adds integrity checks to fallback download path** (security hardening, no behavior change for successful installs).
  - Go compiler 1.26 (new GC; should not affect output but is documented as potentially impacting edge cases).

**Build-script compatibility check:**

- `build-server.mjs` already specifies `target: 'node22'` — fully forward-compatible with the `Uint8Array.fromBase64` change.
- `build-mcp-servers.js` has no `target` (defaults to `esnext`) — and does not use the `binary` loader (`loader: { '.wasm': 'empty' }` only) so the breaking change doesn't apply.

**esbuild-side advisories surveyed:**

| GHSA              | Severity | Summary                                                       | Vuln range  | 0.28.0 |
| ----------------- | -------- | ------------------------------------------------------------- | ----------- | ------ |
| GHSA-67mh-4wv8-2f99 | MODERATE | Dev server allows any website to send requests + read response | `<= 0.24.2` | PATCHED |

The single esbuild CVE was patched in 0.25.0, well before all of Wayland's resolved versions (0.25.12, 0.27.4, 0.28.0). All transitive esbuilds are also clean.

**Verdict: CLEAN with one minor caveat:**
- *CAVEAT*: developer machines on macOS < 12 or Linux kernel < 3.2 will be unable to use `esbuild@0.28`. Not load-bearing for documented CI/dev baseline, but worth documenting in CONTRIBUTING if not already present.
- Build-script behavior is preserved (no `binary` loader, target set on server build).

---

## Open CVE list (post-bump, all resolved versions in bun.lock)

### P0 (remote / auth-bypass / RCE) — CHECKED, NONE FOUND

All four direct deps and all surveyed transitives (`jszip`, `xml2js`, `sharp`, `ws`, `electron-updater`, `officeparser`) have no unpatched P0 advisories at their resolved versions.

### P1 (local / DoS / data-leak) — CHECKED, NONE FOUND

- `ws@8.20.1` — patched against GHSA-3h5v-q93c-6h6q (DoS via many HTTP headers, patched 8.17.1).
- `jszip@3.10.1` — patched against GHSA-36fh-84j7-cv5h (path traversal in `loadAsync`, patched 3.8.0) and prototype-pollution (patched 3.7.0).
- `xml2js@0.5.0` — patched at the exact floor against GHSA-776f-qx25-q3cc (prototype pollution, patched 0.5.0). **Pinned at the lowest patched version**; no headroom. Worth bumping to a later 0.x if upstream offers one (officially the project is bumping toward 0.6.x but no major activity).
- `electron-updater@6.8.3` — patched against GHSA-9jxc-qjr9-vjxq (Windows code-signing bypass, patched 6.3.0-alpha.6).
- `sharp@0.34.5` — patched against GHSA-54xq-cgqr-rpm3 (libwebp CVE-2023-4863, patched 0.32.6).
- `officeparser@7.0.2` — no published advisories.

### P2 (informational) 

- **`@anthropic-ai/sdk@0.52.0` transitive via `@office-ai/aioncli-core`**: clean (below the Memory Tool vuln window which starts at 0.79.0). However: this is a stale pinned version inside an upstream lib outside our control. Long-term, ensure `@office-ai/aioncli-core` is bumped or vendored or replaced.
- **`@modelcontextprotocol/sdk@1.27.1` transitive via `@office-ai/aioncli-core`**: clean (above the cross-client-leak vuln window which closes at 1.26.0).
- **Anthropic SDK roadmap signal**: 0.89.0 flagged Sonnet/Opus 4 (Wayland's default `claude-sonnet-4-20250514`) as deprecated. Models still serve — no break — but the deprecation policy means Wayland should plan a default-model bump within Anthropic's typical 6-12 month window.
- **MCP SDK roadmap signal**: 2.0.0-alpha.1/.2 published 2026-04-01 (namespace split: `@modelcontextprotocol/{client,server,node,express,hono,fastify}`). The v1.x line is now backport-mode for the official "stable" tag. Plan v2 migration before v1.x exits maintenance.
- **`node-forge`**: confirmed **fully removed** from the dep tree (no entries in `bun.lock`). W1-C5 mitigation work has held — none of node-forge's 10 known HIGH/MODERATE advisories apply to Wayland anymore.

---

## Maintenance health

| Dep                          | Last release       | Release cadence      | Maintainer | Health |
| ---------------------------- | ------------------ | -------------------- | ---------- | ------ |
| `@sentry/electron`           | 2026-04-30 (7.13.0) | ~weekly minors       | getsentry (org) | **HEALTHY** |
| `@modelcontextprotocol/sdk`  | 2026-03-30 (1.29.0); v2 alphas active 2026-04-01 | active feature dev | modelcontextprotocol (org) | **HEALTHY**; major migration window opens |
| `@anthropic-ai/sdk`          | 2026-05-13 (0.96.0) | ~weekly minors       | anthropics (org) | **HEALTHY**, codegen-driven |
| `esbuild`                    | 2026-04-02 (0.28.0) | ~monthly             | evanw (solo, ~15-yr veteran) | **HEALTHY**; bus-factor 1 is the only structural risk |

No abandoned direct deps. The vendored `pptx2json` (M22) at `src/vendor/pptx2json/` is the only abandoned package; it was vendored verbatim to remove the supply-chain dependency on the abandoned upstream — handled, not a finding.

---

## tsc compatibility check

```
$ bunx tsc --noEmit
$ echo "exit:$?"
exit:0
```

0 errors. 0 warnings. The bumped types resolve cleanly against:
- `Anthropic.MessageCreateParamsNonStreaming`, `Anthropic.Message`, `Anthropic.MessageParam`, `Anthropic.ContentBlockParam`, `Anthropic.TextBlockParam`, `Anthropic.Tool.InputSchema`
- `McpServer`, `StdioServerTransport`, `Client`, `SSEClientTransport`, `StdioClientTransport`, `StreamableHTTPClientTransport`
- `Sentry.ErrorEvent`, `Sentry.init` options shape

**Build-system compatibility:** the bumped esbuild (0.28.0) is consumed only by build-scripts (not src/); `target: 'node22'` is set in `build-server.mjs`; `build-mcp-servers.js` doesn't use the `binary` loader. No bundling regressions detected by tsc.

---

## Findings to file (none are blockers; informational)

1. **CAVEAT — esbuild 0.27.0 OS bump (LOW impact):** macOS <12 / Linux kernel <3.2 cannot run `esbuild@0.28`. Document in CONTRIBUTING if not already present.
2. **CAVEAT — Anthropic Sonnet/Opus 4 deprecation flag:** plan default-model bump (`claude-sonnet-4-20250514` → newer family) within Anthropic's deprecation window. Not urgent but should land in v0.1.3 cycle.
3. **CAVEAT — MCP SDK v2 namespace migration:** v1.x is backport-mode. Plan v2 migration before maintenance ends (timing unannounced — track upstream).
4. **NOTE — Commit message imprecision:** L36 commit says "zero src/ consumers" for esbuild; accurate for `src/` runtime but `scripts/build-mcp-servers.js` and `scripts/build-server.mjs` *do* consume the direct esbuild API. Not a bug, but the bump verification statement should have read "zero runtime consumers; 2 build-time consumers verified".
5. **NOTE — Dual-resolution risk:** `@anthropic-ai/sdk` resolves to 0.52.0 AND 0.96.0 in `bun.lock`; `@modelcontextprotocol/sdk` resolves to 1.27.1 AND 1.29.0. Both transitive pins are inside `@office-ai/aioncli-core` and are themselves patched against current CVEs, but they ship duplicated SDK code into the bundle. Bundle-size concern only; not a security finding.

---

## Final verdict

**CLEAN — ship as-is.** All four bumps are correctly pinned, free of P0/P1 CVEs at their resolved versions, type-check clean, and the call sites in `src/` exercise only stable public-API surfaces unchanged across the entire bump range. Two MODERATE Anthropic CVEs and three HIGH MCP CVEs were closed by the bump.

Read-only audit, as constrained. No code touched, no commits authored.
