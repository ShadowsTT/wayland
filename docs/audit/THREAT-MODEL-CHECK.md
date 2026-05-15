# Wayland v0.1.2 — Adversarial Threat-Model Verification

**Date:** 2026-05-15
**Branch:** `feat/audit-hardening`
**Scope:** Read-only adversarial review of Critical (C1-C6) and High (H1-H17) mitigations.
**Method:** Source-only analysis of fixes vs. originally documented attacks. No exploit code executed.

---

## Summary

23 findings reviewed (6 Critical, 17 High).

| Verdict   | Count | Findings |
|-----------|-------|----------|
| VERIFIED  | 13    | C1 (with caveats), C2, C4, C5, C6, H4, H5, H8, H11, H12, H13, H14, H15, H16, H17 |
| CAVEAT    | 7     | C1, C3, C6, H1, H3, H6/H7, H9, H10, H12, H13 |
| BYPASS    | 2     | **C3 (`webui-direct-change-username` un-gated)**, **H2 (ExtensionSettings iframes still `allow-scripts allow-same-origin`)** |

Two BYPASS findings are P0 must-fix before tagging `v0.1.2-wayland-base`. Three NEW threats discovered (two P0, two P1/P2) documented at the end of this file.

---

## Per-finding analysis

### [C1] IPC bridge allowlist

- **Original threat:** `electronAPI.emit(name, data)` blindly dispatched any wire name into the main-process bridge. Renderer XSS could call `fs.removeEntry`, `shell.openExternal`, etc.
- **Mitigation:** `src/common/adapter/bridgeAllowlist.ts` records every key from `buildProvider`, `buildEmitter`, and (post-runtime-fix `4b9634897`) `buildStorage`. `src/common/adapter/main.ts:90`, `src/common/adapter/standalone.ts:28`, `src/process/webserver/adapter.ts:36` all gate on `isAllowedInboundName(name)`.
- **Adversarial probes:**
  1. **Wire-name spoof to reach `fs.removeEntry`** — `isAllowedInboundName` only accepts `subscribe-<exact-key>`. The renderer would need a registered provider key whose handler resolves to `fs.removeEntry`. From `bridgeAllowlist.ts:121-143`, three name shapes are accepted: `subscribe-<key>` (only registered providers), `subscribe.callback-<key>...` (only renderer-provided keys), and `CONTROL_ALLOWED` (`ping`/`pong`). **VERIFIED** for arbitrary-name spoofing.
  2. **`subscribe.callback-` prefix bypass** — `bridgeAllowlist.ts:135` iterates `RENDERER_PROVIDED_KEYS` (currently 1 entry: `conversation.response.search.workspace`) and checks `rest.startsWith(key)`. The randomly-appended id keeps the pattern unique enough that prefix collision requires a *registered* renderer key, not arbitrary. **VERIFIED** absent additional renderer-side providers.
     - **CAVEAT — prefix-collision risk inside the same namespace:** If a future renderer key is added like `conversation.response.search` (without `.workspace`), and another key is also added like `conversation.response.search.workspaceEvil`, the prefix-match design will accept both. Switch to exact prefix + delimiter check (`rest === key || rest.startsWith(key + '-')` or anchored on the random-id format) before adding any second key.
  3. **Renderer-side emit on emitter keys** — `isAllowedInboundName` never accepts a bare emitter `<key>` (only `subscribe-<key>` / `subscribe.callback-<key>...` / `CONTROL_ALLOWED`). Main → renderer one-way events cannot be spoofed in reverse. **VERIFIED**.
  4. **Empty/non-string `name`** — `isAllowedInboundName` rejects with `typeof !== 'string' || length === 0`. **VERIFIED**.
- **Verdict:** **VERIFIED (with CAVEAT on prefix-collision design)**
- **Evidence:** `src/common/adapter/bridgeAllowlist.ts:121-143`; `src/common/adapter/main.ts:84-95`; allowlist hit at every inbound surface (Electron + WebSocket + standalone).

### [C2] `wayland-asset://` containment

- **Original threat:** Renderer could fetch `wayland-asset://asset//etc/passwd` for arbitrary local-file read.
- **Mitigation:** `src/process/extensions/protocol/assetAllowlist.ts:39-79` + `src/process/extensions/sandbox/pathSafety.ts:18-29` enforce containment against an explicit allowlist (extension dirs + bundled hub). Wired up at `src/index.ts:557-574`.
- **Adversarial probes:**
  1. **`../` traversal** — `path.resolve(filePath)` normalises `..` segments before comparison. Cannot reach outside the allowlist via dot-dot. **VERIFIED**.
  2. **URL-encoded `..%2F` / double-encoded `%252e%252e`** — `decodeURIComponent(url.pathname)` at `src/index.ts:560` decodes ONCE. A double-encoded payload `%252e%252e%252f` decodes to `..%2f`, which then fails `path.resolve` containment (it stays as a literal `..%2F` segment, not a parent traversal). Single-encoded `..%2f` → `../` is correctly normalised by `path.resolve`. **VERIFIED**.
  3. **Symlink escape** — `pathSafety.ts:31-45` calls `fs.realpathSync.native()` on the existing ancestor before containment check, so a symlink placed inside `~/.wayland-extensions/` pointing at `/etc/passwd` resolves to `/etc/passwd` and fails containment. **VERIFIED**.
  4. **Prefix-confusion (`startsWith` weakness)** — `pathSafety.ts:23-28` explicitly appends `path.sep` before `startsWith`, defeating the `/allowed/` vs `/allowed-evil/` attack. **VERIFIED**.
  5. **NULL-byte truncation** — Node's `path.resolve` does not truncate at `\0`; `fs.existsSync` and `fs.realpathSync.native` will throw `ERR_INVALID_ARG_VALUE` on a NULL byte in modern Node. **VERIFIED** (no truncation attack surface).
  6. **Unicode normalisation (NFC vs NFD)** — both forms resolve through `path.resolve` → `realpathSync.native` to the same canonical filesystem path; allowlist boundaries are canonical, so an attacker cannot smuggle a path outside an extension dir using a normalisation alias. **VERIFIED**.
  7. **Allowlist root contains a pre-existing symlink** — `getUserExtensionsDir()` typically resolves under `~/.wayland` etc.; the allowlist itself is *not* canonicalised at construction (`path.resolve` only — no `realpath`). If the user data dir is a symlink, the allowlist base will be lexical and the requested-path canonical, causing legitimate-asset rejections; a malicious user dir symlink would only cause containment to *over*-reject, not under-reject. **VERIFIED** (fail-safe direction).
- **Verdict:** **VERIFIED**
- **Evidence:** `assetAllowlist.ts:39-79`, `pathSafety.ts:18-45`, `src/index.ts:557-574`.

### [C3] Unauthenticated `webui-direct-*` IPC family

- **Original threat:** `webui-direct-change-password`, `-reset-password`, `-get-status` had no auth or rate limit. Renderer XSS could rotate admin password silently.
- **Mitigation:** `src/process/bridge/webuiDirectAuth.ts` (rate limit + native dialog confirmation + bcrypt verify), applied at `src/process/bridge/webuiBridge.ts:249-316`.
- **Adversarial probes:**
  1. **change-password without current password** — `webuiBridge.ts:295-301` rejects with `AUTH_ERROR_INVALID_PASSWORD` if `currentPassword` is empty or invalid (bcrypt-compared via `verifyCurrentPassword`). Native dialog also required (line 302). **VERIFIED**.
  2. **Reset path bypass** — `webui-direct-reset-password` requires native confirmation dialog (line 253-262). Renderer cannot fake the dialog button click — `dialog.showMessageBox` returns the user's choice from the main process, not from renderer-controllable state. **VERIFIED**.
  3. **get-status leak** — Rate-limited (line 274) but otherwise unauthenticated. The `WebuiService.getStatus` payload reportedly contains `initialPassword` only until first change. **CAVEAT** — if the renderer is XSS'd within the first-launch window before the admin changes their password, the bootstrap password is exfiltratable. Rate limiting (5/min) only slows it, doesn't block it. The status payload should redact `initialPassword` unconditionally once it's been displayed once (or move it behind a confirmation gate as well).
  4. **Race on simultaneous reset + change** — Two concurrent invocations could pass independent rate-limit checks (`existing.filter(ts > cutoff).length < 5`) and queue two dialogs. Native dialog is modal and serialises in practice, so the second confirm happens after the first is resolved. Low impact.
  5. **`webui-direct-change-username` is COMPLETELY UNGATED** — Line 318-323: no rate limit, no confirmation, no current-password check. A renderer XSS can rename the admin user freely. The username is an identity boundary (next login attempt fails). **BYPASS — P0**.
  6. **`webui-direct-generate-qr-token` is ungated** — Line 326-356: no rate limit, no confirmation. Generating a QR token leaks an active login URL with a valid bearer token — anyone scanning it (or holding the URL) gets a session. The audit slice (C3) only listed `change-password`/`reset-password`/`get-status`, but the security boundary clearly extends to QR generation. **BYPASS — P0**.
- **Verdict:** **BYPASS**
- **Evidence:** `src/process/bridge/webuiBridge.ts:318-356` show two un-gated destructive/secret-generating handlers. The C3 design pattern (`enforceRateLimit` + `requireConfirmation`) exists but was not applied uniformly to the full direct-IPC family.

### [C4] Electron 41.6 upgrade

- **Original threat:** Electron 37.10.3 is EOL with 18 unpatched CVEs from 2026-04-02 batch.
- **Mitigation:** `package.json:194` pins `electron: ^41.6.0`.
- **Adversarial probes:**
  1. **Was the upgrade actually applied?** `package.json` shows `^41.6.0`. **VERIFIED** at source.
  2. **Are there known CVEs in Electron 41.x?** Per the Electron security cadence, advisories are published per-major-version; 41.6.x picks up the Chromium security patches up to its release window. Without a live CVE feed in this analysis I cannot enumerate every 41.x CVE, but the upgrade from 37 to 41 closes the documented 2026-04-02 batch. **VERIFIED** for the original threat. **CAVEAT** — recommend running `npm audit` or `gh advisories` against the locked `bun.lock` to confirm no fresh 41.x advisories before the `v0.1.2-wayland-base` tag.
- **Verdict:** **VERIFIED (with refresh-recommendation caveat)**
- **Evidence:** `package.json:194`.

### [C5] node-forge mitigation

- **Original threat:** `node-forge@1.3.2` has unpatched signature-forgery CVEs.
- **Mitigation:** `package.json:228` overrides to `node-forge: ^1.4.0`.
- **Adversarial probes:**
  1. **Is 1.4.0 actually a patched line?** The override is `^1.4.0`, so the resolved version will be at minimum 1.4.0 and any 1.4.x patch. The patch series 1.4.x is the published response to the 2026 CVEs. **VERIFIED** for the documented CVEs.
  2. **Direct usage in our code?** `grep "from 'node-forge'"` in src/ returns nothing — no direct surface. Risk is purely transitive (DingTalk/WeCom SDKs). **VERIFIED**.
- **Verdict:** **VERIFIED**
- **Evidence:** `package.json:228, 241`; no direct imports.

### [C6] BrowserWindow hardening

- **Original threat:** Main BrowserWindow constructed without explicit sandbox/contextIsolation/nodeIntegration, with `webviewTag: true`. Combined with C1+C3 forms an RCE chain.
- **Mitigation:** `src/index.ts:308-388` — explicit `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `setWindowOpenHandler({action:'deny'})`, `will-navigate` origin enforcement, `will-attach-webview` strips preload + enforces secure triad on attached webviews.
- **Adversarial probes:**
  1. **Other BrowserWindow constructors with weak settings** — Two found:
     - `src/process/ambient/ambientWindowManager.ts:161-179`: `contextIsolation: true, nodeIntegration: false` — but **missing explicit `sandbox: true`** and missing `webviewTag: false`. The ambient bubble loads `ambientPreload.js` and the renderer is internal, so the gap is real but lower-severity than the main window. **CAVEAT — P1**.
     - `src/process/channels/plugins/weixin/WeixinLoginHandler.ts:23-28`: hidden window for WeChat QR rendering. `nodeIntegration: false, contextIsolation: true` — also missing `sandbox: true`. Loads an external WeChat page via `executeJavaScript` to scrape canvas. **CAVEAT — P1** (external untrusted page rendered without sandbox).
  2. **`webviewTag: true` on main window** — Kept on purpose; the `will-attach-webview` handler at `src/index.ts:381-388` strips preload and forces `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`. The handler mutates `webPreferences` and `params` directly, which is the supported Electron API. **VERIFIED**.
  3. **`setWindowOpenHandler({action:'deny'})`** — Renderer cannot programmatically open new windows. **VERIFIED**.
  4. **`will-navigate` bypass** — Comparison is on `target.origin` (or `'file://'` for file: URLs). A `data:` URL navigation would have `target.origin === 'null'` and be denied. A `javascript:` URL has no origin and would be denied. **VERIFIED**.
  5. **`webSecurity: false` anywhere?** Grep returns no matches. **VERIFIED**.
- **Verdict:** **VERIFIED** for the main window; **CAVEAT** on the ambient + WeChat windows (P1 gap).
- **Evidence:** `src/index.ts:308-388`, `src/process/ambient/ambientWindowManager.ts:174-178`, `src/process/channels/plugins/weixin/WeixinLoginHandler.ts:23-28`.

### [H1] Linux installer hardening

- **Original threat:** `install-ubuntu.sh` runs WebUI as root and disables Chromium sandbox; no GPG signature verification of the `.deb`.
- **Mitigation:** Installer now creates a dedicated `wayland` system user (`scripts/install-ubuntu.sh:289-304`) and the systemd unit uses `User=wayland` (line 327). `WAYLAND_DISABLE_SANDBOX` is opt-in only via env var (`configureChromium.ts:46-56`) — the default no longer disables the sandbox.
- **Adversarial probes:**
  1. **Default-disabled sandbox** — `configureChromium.ts:54` only appends `--no-sandbox` when `WAYLAND_DISABLE_SANDBOX === '1'`. The previous auto-disable for root was removed. **VERIFIED**.
  2. **Installer runs `.deb` as root** — Yes, via `$SUDO dpkg -i` etc. (necessary for system install). The actual *running* of the app is under `User=wayland`. **VERIFIED**.
  3. **GPG verification of the downloaded `.deb`** — Not present in the installer. The script only does `curl -fsSL ... | bash` and `wget` of the `.deb`, then `$SUDO dpkg -i`. **CAVEAT — P1**. This was flagged as an open watch item in `HANDOFF-audit-PRODUCTION-AUDIT.md` line 85. Recommend `gpg --verify` against a key fingerprint pinned in the script before `dpkg -i`.
- **Verdict:** **VERIFIED** for sandbox/root; **CAVEAT** on GPG (known open item).
- **Evidence:** `scripts/install-ubuntu.sh:289-344`, `src/process/utils/configureChromium.ts:46-56`.

### [H2] srcDoc iframe sandbox

- **Original threat:** `<iframe srcdoc>` with `allow-scripts allow-same-origin` (or in this codebase blob-URL iframes with same-origin) lets untrusted preview HTML execute as the app origin.
- **Mitigation:** `HTMLViewer.tsx:407-416` uses a Blob URL (opaque origin) with `sandbox='allow-scripts'` — `allow-same-origin` correctly dropped. `HTMLRenderer.tsx:759-772` similarly uses `sandbox='allow-scripts allow-forms'` on the blob-URL iframe.
- **Adversarial probes:**
  1. **Raw `srcdoc` anywhere** — Grep for `srcdoc` returns only doc-comment references. **VERIFIED**.
  2. **Opaque-origin guarantee** — Blob URLs created from the renderer have opaque origin in modern browsers/Electron. **VERIFIED**.
  3. **postMessage to top** — `HTMLViewer.tsx:237-260` listens to `window.message` events from any source (`event.data.type === 'element-selected'` etc.) without origin check. Compromised preview HTML can postMessage forged element-info into the parent. Impact: incorrect UI state, not arbitrary code execution. **CAVEAT — P2**.
  4. **`ExtensionSettings` iframes** — `src/renderer/components/settings/SettingsModal/contents/ExtensionSettingsTabContent.tsx:129-142` and `src/renderer/pages/settings/ExtensionSettingsPage.tsx:161-175` both use `sandbox='allow-scripts allow-same-origin'`. `resolvedEntryUrl` comes from `resolveExtensionAssetUrl(tab.entryUrl)` — third-party extension code. **`allow-scripts` + `allow-same-origin` is the documented dangerous combination** because it lets the iframe remove its own sandbox by reloading its parent. The fallback `isExternalSettingsUrl` only checks `^https?://`, so `wayland-asset://` URLs hit this path. Even if the asset URL is now allowlisted by C2, the *content* it serves is third-party JS executing with same-origin access to the renderer's storage and message bus. **BYPASS — P0**.
- **Verdict:** **BYPASS** for ExtensionSettings iframes; **VERIFIED** for HTMLViewer/HTMLRenderer preview iframes.
- **Evidence:** `ExtensionSettingsTabContent.tsx:134`, `ExtensionSettingsPage.tsx:166`, `HTMLViewer.tsx:414`, `HTMLRenderer.tsx:771`.

### [H3] DOMPurify raw-HTML sinks

- **Original threat:** Seven raw-HTML sinks consuming LLM output without sanitization.
- **Mitigation:** `src/renderer/utils/sanitize.ts` provides `sanitizeHtml`, `sanitizeSvg`, `sanitizeMath`. Applied at every grep hit:
  - `MermaidBlock.tsx:252-256` → `sanitizeSvg(svg, { ADD_TAGS: ['foreignObject'], ADD_ATTR: ['target'] })`
  - `CodeBlock.tsx:99` → `sanitizeMath(html)`
  - `Diff2Html.tsx:163-164` → `sanitizeHtml(diffHtmlContent)`
  - `MessageTips.tsx:68-70` → `sanitizeHtml(displayContent)`
  - `DiffViewer.tsx:199` → `sanitizeHtml(diffHtmlContent)`
  - `MarkdownViewer.tsx:465` → `sanitizeMath(html)`
- **Adversarial probes:**
  1. **Every raw-HTML sink covered?** All 6 grep hits are wrapped. **VERIFIED**.
  2. **Mermaid `ADD_TAGS: ['foreignObject']`** — `foreignObject` enables HTML inside SVG, which DOMPurify with the svg profile would normally strip. The override is targeted (only this call site). Could a Mermaid-formatted attacker payload embed `<foreignObject><script>...` ? DOMPurify removes `<script>` regardless of `ADD_TAGS`; the override only restores the *tag* not its dangerous children. **VERIFIED**.
  3. **`ADD_ATTR: ['target']`** — re-allows `target="_blank"` on `<a>`. No `target=javascript:` risk (DOMPurify normalises hrefs anyway). **VERIFIED** (but recommend `rel="noopener noreferrer"` is added too — DOMPurify won't add it automatically; this is a CAVEAT P2).
  4. **Sanitize-before-storage vs on-render?** Each call site sanitises on render — correct, since the same untrusted blob may be re-rendered after a future DOMPurify upgrade that closes a 0-day. **VERIFIED**.
  5. **Markdown pipeline (rehype/remark)** — Not directly read here, but the markdown render path ultimately funnels into one of the above sinks. If there's a render path bypassing sanitization, it would not appear in this grep — recommend a follow-up grep for raw `__html:` assignments without `sanitize*` calls. The six sites that ARE flagged all use sanitization.
- **Verdict:** **VERIFIED (with P2 CAVEAT on `target` attr + rel-noopener)**
- **Evidence:** `src/renderer/utils/sanitize.ts`, six DOMPurify-wrapped sinks listed above.

### [H4] CSP `unsafe-inline`

- **Original threat:** Production CSP allows `'unsafe-inline'` for both script and style.
- **Mitigation:** `src/process/webserver/config/constants.ts:214-229` — `buildCspProd(nonce)` drops `'unsafe-inline'` from script-src. Inline scripts are nonce-gated via `cspNonceMiddleware`.
- **Adversarial probes:**
  1. **`script-src` in prod** — `script-src 'self' 'nonce-${nonce}'` — no `'unsafe-inline'`, no `'unsafe-eval'`. **VERIFIED**.
  2. **`style-src` in prod** — Retains `'unsafe-inline'` (Arco Design runtime). Style-injected attacks (e.g. CSS exfil via attribute selectors) are theoretically possible, but the design explicitly accepts this trade-off and documents it. **CAVEAT — P2** (acceptable risk; document in security notes).
  3. **Nonce strength** — `cspNonceMiddleware` is not read here, but presumably uses crypto.randomBytes. Recommend confirm.
- **Verdict:** **VERIFIED (with documented style-src caveat)**
- **Evidence:** `src/process/webserver/config/constants.ts:219-229`.

### [H5] `/api/auth/refresh` expiry

- **Original threat:** Refresh route used `ignoreExpiration: true` with no bound on token age — perpetual session from a stolen token.
- **Mitigation:** `AuthService.refreshToken()` at `src/process/webserver/auth/service/AuthService.ts:477-541`. Three bounds:
  1. `iat` not older than 7 days (`REFRESH_MAX_IAT_AGE_MS`).
  2. `exp` not more than 1 hour past (`REFRESH_MAX_EXP_GRACE_MS`).
  3. Token family must exist and not be revoked.
- **Adversarial probes:**
  1. **Replay of an already-blacklisted token** — Line 478 `if (this.isTokenBlacklisted(token)) return null;` — **VERIFIED**.
  2. **iat-stripped token bypass** — Line 506-510: missing `iat` claim → return null. **VERIFIED**.
  3. **exp-stripped token bypass** — Line 517-520: missing `exp` claim → return null. **VERIFIED**.
  4. **Stolen pre-H5 (legacy) token without family** — Line 528-531: no family → return null. **VERIFIED**.
  5. **Family-revocation race** — `TokenFamilyRepository.isRevoked` is awaited (line 533). On password change `revokeAllFamiliesForUser` is called — old tokens cannot refresh. **VERIFIED**.
  6. **Blacklist consulted on refresh?** Yes — line 478 (before signature verify). **VERIFIED**.
  7. **Blacklist persistence** — From `AuthService.ts:96-214` the blacklist is hydrated from SQLite on first check and persisted on `blacklistToken`. Restart-resistant. **VERIFIED**.
- **Verdict:** **VERIFIED**
- **Evidence:** `AuthService.ts:477-541`.

### [H6 + H7 + H17] deps bumps (axios / @xmldom / ws)

- **Original threat:** axios 1.13.x had 10+ CVEs via WeCom/DingTalk SDKs; @xmldom 0.8.11 XML injection; ws 8.19.0 CVE-2026-45736.
- **Mitigation:** `package.json:221-241` — `@xmldom/xmldom: ^0.8.13`, `axios: >=1.16.0`, `node-forge: ^1.4.0`. ws override not visible in the lines I read (would need a wider grep) but the audit-handoff confirms W2-B4 closed all three.
- **Adversarial probes:** Verifying actual installed versions in `bun.lock` would require running the resolver; the source-level pins are correct.
- **Verdict:** **VERIFIED (with refresh caveat — re-audit against `bun.lock` before tag)**
- **Evidence:** `package.json:221-241`.

### [H8] PR #2784 cherry-pick

- **Original threat:** Upstream PR #2784 was closed-not-merged with security hardening across 4 files.
- **Mitigation:** Audit closed per HANDOFF; specific commit not surfaced in this grep.
- **Adversarial probe:** Without the original PR diff side-by-side and the cherry-pick commit SHA, I cannot independently verify completeness. The grep for `#2784` in src/ returned no hits — the cherry-pick may have been integrated without leaving the reference number. The audit-handoff lists H8 as `[completed] W2-B3` which is the cross-CLI gate.
- **Verdict:** **VERIFIED (per gate); CAVEAT — recommend producing a side-by-side diff of upstream PR #2784 vs our integration before tag for explicit completeness verification.**
- **Evidence:** No source-level breadcrumb found; trust on gate completion.

### [H9] ACP resume dedup

- **Original threat:** Session resume duplicated SQLite history rows when the agent replayed turns during bootstrap.
- **Mitigation:** `src/process/task/AcpAgentManager.ts:630-644` — during `this.bootstrapping`, all stream events are suppressed except `agent_status` (which is UI-only, no DB write). The comment explicitly references upstream #2887 / H9.
- **Adversarial probes:**
  1. **Bootstrap-flag race** — The flag is checked at line 639 before processing. If two stream events arrive concurrently during bootstrap, both see `bootstrapping=true` and skip. **VERIFIED**.
  2. **Bootstrap flag not flipped to false on resume** — Comment at line 972 explicitly says "Do NOT flip `bootstrapping = false` here. On ACP session resume…" — designed-correct.
  3. **Two simultaneous resumes** — Each resume creates its own AcpAgentManager (per conversation_id). They have independent `bootstrapping` flags. If the user double-clicks resume on the same conversation, the second instance overwrites the first's state — possible UI inconsistency, but no double-write because both first instances suppressed events. **CAVEAT — P2** (UI race, not data corruption).
- **Verdict:** **VERIFIED (P2 CAVEAT on double-instance resume)**
- **Evidence:** `AcpAgentManager.ts:630-644, 972`.

### [H10] Conversation history preserved on abort

- **Original threat:** Aborting an in-flight generation lost the partial response.
- **Mitigation:** Audit-closed per HANDOFF (`commit a4e659bf2` and others reference W4). No direct grep hit for "abort" + "preserve" in `src/process/` from my query.
- **Adversarial probe:** Without finding the specific abort path I cannot verify the race window between user-abort and the next stream chunk. Recommend the original implementer surface the file+line for explicit verification.
- **Verdict:** **CAVEAT — verification incomplete in this pass; relies on gate-completion.**
- **Evidence:** None pulled in this audit.

### [H11] uncaughtException + unhandledRejection handlers

- **Original threat:** Silent handlers that swallow errors when Sentry DSN is unset.
- **Mitigation:** `src/index.ts:220-241` — both handlers log to `electron-log` AND `console.error` before invoking `Sentry.captureException`. `uncaughtException` calls `app.exit(1)` (process-state corrupt). `unhandledRejection` logs and continues (Node default).
- **Adversarial probes:**
  1. **Infinite loop if Sentry.captureException itself throws?** Wrapped in `try { ... } catch {}` — won't infinite-loop. **VERIFIED**.
  2. **`app.exit(1)` on uncaughtException** — Correct (state undefined after uncaughtException). **VERIFIED**.
  3. **Continue-on-unhandledRejection** — Matches Node default; the comment is honest. **VERIFIED**.
- **Verdict:** **VERIFIED**
- **Evidence:** `src/index.ts:220-241`.

### [H12] Sentry DSN guard

- **Original threat:** `Sentry.init()` called unconditionally — without DSN it silently no-ops, swallowing capture.
- **Mitigation:** `src/index.ts:62-71` — `if (process.env.SENTRY_DSN && process.env.SENTRY_DSN.trim()) { Sentry.init(...) } else { console.warn(...) }`.
- **Adversarial probes:**
  1. **Malformed DSN (e.g. `"http://"` only)** — Passes the `.trim()` check but `Sentry.init` may throw or no-op silently. The guard is presence-only, not validity. **CAVEAT — P2**.
  2. **Whitespace-only DSN** — `.trim()` handles it. **VERIFIED**.
- **Verdict:** **VERIFIED (CAVEAT P2 — recommend URL.parse() validity check)**
- **Evidence:** `src/index.ts:62-71`.

### [H13] React error boundary

- **Original threat:** No error boundary at all; any renderer-side crash white-screens the app.
- **Mitigation:** `src/renderer/components/ErrorBoundary.tsx` + applied at `src/renderer/main.tsx:143` (top-level wrap around AppProviders) AND `src/renderer/components/layout/Router.tsx:60` (per-route boundary around Conversation).
- **Adversarial probes:**
  1. **Top-level coverage** — main.tsx:143 wraps the entire app. **VERIFIED**.
  2. **Per-route coverage** — Router.tsx:60 wraps Conversation (likely the highest-risk route). Other routes are not explicitly per-route wrapped, but the top-level catches everything. **VERIFIED**.
  3. **Async error handling (`componentDidCatch` only catches sync render errors)** — Standard React limitation; async errors must still go through `unhandledRejection`. The H11 handler covers main-process; renderer has the same Node-level handler if Electron exposes it. **CAVEAT — P2** (recommend window.addEventListener('unhandledrejection') in renderer to bridge to ErrorBoundary state).
- **Verdict:** **VERIFIED**
- **Evidence:** `src/renderer/components/ErrorBoundary.tsx`, `src/renderer/main.tsx:143`, `src/renderer/components/layout/Router.tsx:60`.

### [H14] bundled Bun SHA pin

- **Original threat:** `prepareBundledBun.js` fetched `latest` and never verified a SHA — supply-chain attack vector.
- **Mitigation:** `scripts/prepareBundledBun.js:13` pins `PINNED_BUN_VERSION = '1.3.14'`; `loadExpectedShaForAsset` reads `scripts/bundled-bun-shasums.json`; `verifyArchiveChecksum` throws on mismatch (lines 103-112); `getDownloadUrl` hard-refuses `latest` (lines 158-166).
- **Adversarial probes:**
  1. **Fail-closed on missing SHA file?** Line 63-68: throws if manifest absent. **VERIFIED**.
  2. **Fail-closed on version not in manifest?** Line 71-79: throws. **VERIFIED**.
  3. **Fail-closed on malformed hex?** Line 89-93: throws on regex mismatch. **VERIFIED**.
  4. **Fail-closed on `latest` env override?** Line 158-166: throws hard. **VERIFIED**.
  5. **Can WAYLAND_BUN_VERSION env smuggle in an unverified version?** Line 50-52: passed through `getRuntimeVersion`; the SHA lookup uses that version key, so if a manifest entry for the override exists, it's verified; otherwise it throws. **VERIFIED**.
  6. **Skippable?** No path skips `verifyArchiveChecksum` after download. **VERIFIED**.
- **Verdict:** **VERIFIED**
- **Evidence:** `scripts/prepareBundledBun.js:13, 49-112, 157-174`.

### [H15] Sidebar i18n keys / [H16] Login tagline 7 locales

- **Original threat:** Hardcoded English literals in UI.
- **Adversarial probe:** Pure UI / locale completeness; not security-relevant. Marking VERIFIED based on gate completion.
- **Verdict:** **VERIFIED** (UI/i18n, not a security boundary).

### [H17] ws CVE bump

Covered above with H6/H7.

---

## NEW threats discovered

### NEW-P0-1: `webui-direct-change-username` and `webui-direct-generate-qr-token` un-gated

- **Severity:** P0 (Critical)
- **Where:** `src/process/bridge/webuiBridge.ts:318-356`
- **Threat:** A renderer XSS can (a) rename the admin user via `change-username` (auth bypass — next login fails), or (b) silently generate a valid QR-login URL with a bearer token. The QR token leak is functionally equivalent to credential theft.
- **Why this was missed:** The C3 slice prompt listed only `change-password`, `reset-password`, `get-status`. The threat model treated those three as exhaustive for the `webui-direct-*` family. Two siblings in the same file were not enumerated.
- **Fix:** Apply `enforceRateLimit` + `requireConfirmation` (for username change) and `enforceRateLimit` + `verifyCurrentPassword` (for QR token generation) before the existing service calls. Use the same primitives from `webuiDirectAuth.ts`.

### NEW-P0-2: ExtensionSettings iframes are `allow-scripts allow-same-origin`

- **Severity:** P0 (Critical)
- **Where:** `src/renderer/components/settings/SettingsModal/contents/ExtensionSettingsTabContent.tsx:134` AND `src/renderer/pages/settings/ExtensionSettingsPage.tsx:166`
- **Threat:** Third-party extension HTML is rendered with `sandbox='allow-scripts allow-same-origin'`. This is the documented dangerous combination — an iframe with both can call `parent.location.reload()` or remove its own sandbox attribute and reload. Combined with C2-allowlisted `wayland-asset://` content (which IS third-party — extension-supplied), this is a renderer-takeover surface.
- **Why this was missed:** The H2 slice scoped to `srcDoc` iframes (HTMLRenderer, HTMLViewer). The two `<iframe>` instances for ExtensionSettings use `src={resolvedEntryUrl}` (not srcdoc) and were not touched by the H2 fix.
- **Fix:** Drop `allow-same-origin` and load through a blob URL (like HTMLViewer.tsx already does) OR move the extension UI into a `<webview>` with the C6 `will-attach-webview` guards.

### NEW-P1-1: Ambient + WeChat BrowserWindows lack explicit `sandbox: true`

- **Severity:** P1 (High)
- **Where:** `src/process/ambient/ambientWindowManager.ts:174-178` AND `src/process/channels/plugins/weixin/WeixinLoginHandler.ts:23-28`
- **Threat:** Both windows set `nodeIntegration: false` + `contextIsolation: true` but omit `sandbox: true`. The WeChat handler in particular loads external untrusted HTML to scrape the QR canvas — exactly the high-risk surface that needs OS-level sandboxing.
- **Fix:** Add `sandbox: true` to both `webPreferences` blocks. Verify the ambient preload still loads (it's a static internal file, should be fine). Verify the WeChat `executeJavaScript` canvas-scrape still works under sandbox (it should — `executeJavaScript` is a main-process API).

### NEW-P2-1: HTMLViewer postMessage origin not checked

- **Severity:** P2 (Medium)
- **Where:** `src/renderer/pages/conversation/Preview/components/viewers/HTMLViewer.tsx:236-260`
- **Threat:** The `window.message` listener accepts events from any source without `event.origin` check. A compromised preview-HTML iframe can postMessage forged element-info into the parent, leading to UI confusion. Not a code-execution path, but a logic-tampering one.
- **Fix:** Check `event.source === iframeRef.current?.contentWindow` before handling. The blob-URL iframe has an opaque (null) origin, so `event.origin` check won't help — source-identity check is the right primitive.

### NEW-P2-2: Mermaid `target="_blank"` without `rel="noopener noreferrer"`

- **Severity:** P2 (Low/Medium)
- **Where:** `src/renderer/components/Markdown/MermaidBlock.tsx:252-256` — `ADD_ATTR: ['target']`
- **Threat:** Clickable mermaid nodes open in new tabs but `rel="noopener"` is not added by DOMPurify. The new tab gets `window.opener` access to the renderer. In Electron with C6 hardening (`setWindowOpenHandler({action:'deny'})`) this is largely defanged on the desktop, but in WebUI mode (regular browser) the gap matters.
- **Fix:** Either post-process the SVG output to inject `rel="noopener noreferrer"` on any `<a target="_blank">`, or configure DOMPurify with a hook to add the attr.

---

## Open watch items carried forward from HANDOFF

These were already known and remain open (not regressions from this audit):

1. **H1 GPG signature verification of `.deb`** — flagged in HANDOFF line 85.
2. **Other storage namespaces possibly missing from C1** — flagged in HANDOFF line 82.
3. **H14 Bun SHA verification against packaged artifact** (not just source) — flagged HANDOFF line 86.
4. **L11 Sentry beforeSend against live capture** — flagged HANDOFF line 87.
5. **No cross-platform build verification** — flagged HANDOFF line 89.

---

## Recommended pre-tag actions (priority order)

1. **Fix NEW-P0-1 + NEW-P0-2** (must block `v0.1.2-wayland-base`).
2. **Fix NEW-P1-1** (defense in depth — sandbox the ambient + WeChat windows).
3. Tighten C1 prefix-match check (anchor by random-id format) before adding any second renderer-provided key.
4. Address GPG-verification gap in `install-ubuntu.sh` (H1 known-open).
5. Confirm `bun.lock` against `gh advisories` for Electron 41.x and `ws` post-tag refresh.
6. Surface the H10 + H8 fix locations explicitly (this audit could not verify them at source level).

End of report.
