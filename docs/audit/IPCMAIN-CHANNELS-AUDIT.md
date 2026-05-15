# Non-Bridge ipcMain Channels — Security Audit

**Audit date:** 2026-05-15
**Scope:** All `ipcMain.handle(...)` and `ipcMain.on(...)` registrations in
`src/` that bypass the C1 bridge allowlist
(`src/common/adapter/bridgeAllowlist.ts`).
**Source for the gap list:** `.blackboard/audit/ALLOWLIST-COVERAGE.md` (Phase 1).

---

## Inventory

Run on `feat/audit-hardening` @ HEAD:

```bash
grep -rn "ipcMain.handle\|ipcMain.on" src/ --include="*.ts" \
  | grep -vE "/__tests__/|\.test\."
```

Result (excluding the C1 bridge mux `ADAPTER_BRIDGE_EVENT_KEY` and the
`webui-direct-*` family which is covered by C3 + the P0-3/4 patches landed
in Wave 1):

| Channel | File | Type |
|---|---|---|
| `feedback:collect-logs` | `src/process/bridge/feedbackBridge.ts:40` | `handle` |
| `weixin:login:start` | `src/process/bridge/weixinLoginBridge.ts:16` | `handle` |
| `ambient:drag-start` | `src/process/ambient/ambientWindowManager.ts:253` | `on` |
| `ambient:drag-end` | `src/process/ambient/ambientWindowManager.ts:254` | `on` |
| `ambient:click` | `src/process/ambient/ambientWindowManager.ts:255` | `on` |

Note the audit brief listed `ambient:drag-click`; the actual wire name is
`ambient:click`. All three ambient channels were assessed.

---

## Threat model recap

The renderer is **not** a trusted boundary. The five `webPreferences` rules
(sandbox + contextIsolation + nodeIntegration:false + nodeIntegrationInWorker
+ webviewTag:false) prevent classic RCE, but they do **not** stop a renderer
compromised via XSS (Markdown render, dependency hijack, MCP-injected
content) from issuing `ipcRenderer.invoke(...)` / `.send(...)` calls to any
registered channel. Every handler outside the C1 allowlist therefore must
either:

1. be informational only (no privileged side-effects, no secret disclosure), or
2. carry its own gate (rate limit, auth, confirmation dialog, or origin check).

---

## Channel-by-channel verdict

### 1. `feedback:collect-logs` — **NEEDS_GATE → fixed**

**Handler.** `src/process/bridge/feedbackBridge.ts`
**Renderer caller.** `electronAPI.collectFeedbackLogs()` →
`src/renderer/components/settings/SettingsModal/contents/FeedbackReportModal.tsx`
(bug-report modal "submit" button).

**What it does.** Reads up to 3 days of `electron-log` files from
`app.getPath('logs')` (a fixed, system-resolved path — **not**
renderer-controlled), gzip-compresses them, returns `{ filename, data }` or
`null`.

**Privileged APIs.** `fs.readFileSync`, `zlib.gzipSync`, `app.getPath`. No
shell, no child_process, no network, no dialogs.

**Disclosure surface.** The returned bytes are the literal contents of our
own log files. Those files may contain:

- internal stack traces / file paths (low),
- model names, prompts, tool args (medium),
- redacted tokens (we run Sentry's `scrubPii`, but redaction is best-effort
  and not contractual for log output).

**Path traversal?** No. `logsDir` comes from `app.getPath('logs')` or
`path.join(userData, 'logs')` — both server-side constants. Filenames are
generated from `Date.toISOString().slice(0, 10)` — no renderer input.

**Exploitability.** A compromised renderer can call this freely. The handler
reads the disk and returns potentially-sensitive content on every call. The
risk profile:

- **Disclosure.** Anything our app has ever logged is exfiltrable in one call.
- **DoS.** Each call does up to 3× `readFileSync` + gzip — repeated invocation
  is cheap from the renderer but expensive on the main process.

**Verdict.** `NEEDS_GATE` — apply rate limit to throttle disclosure rate and
prevent main-process I/O DoS. Path is safe; content disclosure is the only
real risk.

**Fix applied.** Wrapped the handler in `enforceRateLimit('feedback:collect-logs')`
(reuses the C3 sliding-window limiter from
`src/process/bridge/webuiDirectAuth.ts`: 5 calls / 60s per channel).
On limit-exceeded, the handler returns `null` — same shape the renderer
already handles as "no logs available", so no type-contract change and no
new UI plumbing needed. The legitimate flow (one click in the bug-report
modal) is far below the limit.

**Note.** A future hardening pass should `scrubPii` the log content before
gzipping, so a renderer that *does* manage to hit the limited rate cap still
cannot exfiltrate raw tokens. Tracked as follow-up, not blocking.

---

### 2. `weixin:login:start` — **NEEDS_GATE → fixed**

**Handler.** `src/process/bridge/weixinLoginBridge.ts` →
`src/process/channels/plugins/weixin/WeixinLoginHandler.ts`.
**Renderer caller.** `electronAPI.weixinLoginStart()` (per `src/preload/main.ts:51`).

**What it does.** Aborts any in-flight WeChat login, then starts a new one:

1. Calls `startLogin()` from `WeixinLogin.ts` (talks to
   `https://ilinkai.weixin.qq.com` — hardcoded `DEFAULT_BASE_URL`).
2. On QR data arrival, opens a **hidden** `BrowserWindow` (300×300, `show:false`,
   sandbox, contextIsolation, nodeIntegration:false) and `loadURL(pageUrl)` —
   where `pageUrl` is supplied by the WeixinLogin callback, **not** by the
   renderer.
3. Polls the hidden window for a `<canvas>` data URL, sends it back to the main
   window via `weixin:login:qr`.

**Privileged APIs.** Opens a `BrowserWindow` + `loadURL` to a network URL +
`executeJavaScript` in that hidden window.

**URL-injection check.** ✅ The renderer cannot influence `pageUrl`. The IPC
handler takes no arguments. `pageUrl` flows from `startLogin → onQR(pageUrl,
qrcodeData)` inside `WeixinLogin.ts`, which is server-side. No XSS-in-renderer
path can redirect the hidden BrowserWindow.

**`executeJavaScript` risk.** ✅ The injected script is a literal string
querying `<canvas>` — no renderer input is interpolated into it.

**Exploitability.** No code-exec or URL-injection. The remaining risks are:

- **Resource exhaustion.** Each call spawns a hidden `BrowserWindow` and a
  10s poll. A compromised renderer spamming the channel could exhaust window
  handles and main-process resources.
- **Legitimate-login DoS.** Each call also `abort()`s the prior login. A
  renderer can cancel a user's in-progress WeChat scan by spamming the
  channel.

**Verdict.** `NEEDS_GATE` — apply rate limit. The handler is fundamentally
fine; the only hostile-renderer leverage is invocation frequency.

**Fix applied.** Wrapped in `enforceRateLimit('weixin:login:start')`. On
limit-exceeded, throws `Error('RATE_LIMITED')` (same constant the C3 family
uses). The renderer's normal error path renders a "Login failed" message —
no new UI path. Legitimate use is one click per login attempt; well below
5/60s.

---

### 3. `ambient:drag-start` / `ambient:drag-end` / `ambient:click` — **SAFE**

**Handlers.** `src/process/ambient/ambientWindowManager.ts:264-308`.
**Renderer caller.** `src/preload/ambientPreload.ts:13-15` → bubble renderer
fires these on mousedown/mouseup/click within the ambient bubble window.

**What they do.**

- `ambient:drag-start`: starts a `setInterval`-based drag-follow that reads
  `screen.getCursorScreenPoint()` (NOT renderer-supplied) and calls
  `BrowserWindow.setPosition(...)` on the ambient bubble; arms an 8s
  watchdog that force-ends the drag if `drag-end` never arrives.
- `ambient:drag-end`: stops the drag timer, restores opacity to 1.0, snaps to
  nearest screen edge, persists position via `ProcessConfig.set`.
- `ambient:click`: logs `'ambient: click, will expand'` to console. M2 placeholder.

**Payload validation.** None of the three handlers reads `event.args` — they
all ignore renderer-supplied data entirely. All position math uses
`screen.getCursorScreenPoint()` (Electron-trusted) and the bubble's own
`getPosition()`.

**Privileged APIs.** `BrowserWindow.setPosition`, `setOpacity`,
`screen.getCursorScreenPoint`, `ProcessConfig.set('ambient.bubblePosition', ...)`
— all bounded to the ambient bubble window only, no path traversal, no
arbitrary fs/shell/net.

**DoS surface.** `drag-start` while a drag is already active triggers
`endDrag()` first (idempotent cleanup), then arms a fresh timer + watchdog
— self-limiting. `drag-end` and `click` are O(1). A flood of `drag-start`
calls could pin a CPU core via the 16ms timer, but only the ambient bubble
window will move, and the watchdog caps any single drag at 8s. The
attack-surface payoff is "move a 64×64 transparent bubble around" — not
worth gating.

**Exploitability.** None worth fixing. A compromised renderer can:

- jiggle the ambient bubble — cosmetic only,
- persist a position out of the visible work area — already clamped by
  `snapAndPersist`,
- spam console with "ambient: click, will expand" — log noise only.

**Verdict.** `SAFE` — no gate applied. These three handlers fit the
"informational/UX-only, no payload" category and intentionally bypass the
C1 bridge for low-latency drag performance. Documented here for the
allowlist coverage record.

**Hardening note for follow-up.** If `ambient:click` ever gains a real
side-effect (M2 plans to expand the bubble into a chat panel), revisit:
unbounded click-to-expand could be used to force-focus / steal-focus from
whatever the user is doing. At that point either gate the handler, debounce
the expansion, or move to a `handle`-style request/response so the renderer
can be rate-limited.

---

## Summary

| Channel | Verdict | Action |
|---|---|---|
| `feedback:collect-logs` | NEEDS_GATE | `enforceRateLimit` added; null on limit |
| `weixin:login:start` | NEEDS_GATE | `enforceRateLimit` added; throws RATE_LIMITED |
| `ambient:drag-start` | SAFE | none |
| `ambient:drag-end` | SAFE | none |
| `ambient:click` | SAFE | none |

No `NEEDS_REWRITE` channels found. All identified gaps closed surgically by
reusing the existing C3 sliding-window limiter
(`src/process/bridge/webuiDirectAuth.ts:enforceRateLimit`); no new modules,
no new dependencies, no contract changes for renderer callers.

**Files touched by this audit:**

- `src/process/bridge/feedbackBridge.ts` (+rate-limit gate, +import)
- `src/process/bridge/weixinLoginBridge.ts` (+rate-limit gate, +import)
- `.blackboard/audit/IPCMAIN-CHANNELS-AUDIT.md` (this file)

**Follow-ups (not blocking this audit):**

1. Apply `scrubPii` to log content inside `feedback:collect-logs` before
   gzip — defense in depth on top of the rate limit.
2. Revisit `ambient:click` when M2 lands its bubble-expansion side-effect.
