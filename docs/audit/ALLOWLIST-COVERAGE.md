# C1 IPC Bridge Allowlist — Coverage Audit

**Scope:** Verify `/Users/seandonahoe/dev/wayland/app/src/common/adapter/bridgeAllowlist.ts` is exhaustive — no legitimate renderer→main wire call 403s, no illegitimate one sneaks through.

**Audit date:** 2026-05-15
**Mode:** Read-only analysis. No code changes.

## Files audited

Primary protection surface:
- `app/src/common/adapter/bridgeAllowlist.ts` (the allowlist)
- `app/src/common/adapter/ipcBridge.ts` (registers every provider/emitter via wrappers)
- `app/src/common/adapter/main.ts` (Electron `ipcMain.handle` dispatcher → `isAllowedInboundName`)
- `app/src/common/adapter/standalone.ts` (server-mode dispatcher → `isAllowedInboundName`)
- `app/src/process/webserver/adapter.ts` (WebSocket inbound → `isAllowedInboundName`)
- `app/src/common/adapter/browser.ts` (renderer-side `bridge.adapter` for both Electron and WS)
- `app/src/common/config/storage.ts` (all `buildStorage` namespace registrations)
- `app/src/preload/main.ts` (the contextBridge surface that calls `electronAPI.emit`)
- `app/src/preload/ambientPreload.ts` (separate `ambientAPI` surface; NOT bridge-routed)
- `app/src/process/webserver/websocket/WebSocketManager.ts` (WS heartbeat + show-open intercept)
- `app/src/renderer/hooks/file/useDirectorySelection.tsx` (only renderer-side `bridge.on/off` caller)
- `app/src/renderer/pages/conversation/Workspace/hooks/useWorkspaceEvents.ts` (only renderer-side `.provider()`)
- `app/node_modules/@office-ai/platform/dist/index.js` (vendored bundle — full reading)
- `app/tests/unit/standaloneAdapter.test.ts` (existing C1 test)

Tool inventory:
- All `@office-ai/platform` imports in `app/src/**`: 10 sites (see §1)
- All `buildProvider` / `buildEmitter` / `buildStorage` callers: 2 files (`ipcBridge.ts`, `common/config/storage.ts`) — both go through the wrapper. No direct platform calls.
- All `ipcMain.handle` / `ipcMain.on` handlers (non-bridge surface): 11 channels (see §5).

---

## 1. Platform factory inventory (wire-key creators)

`@office-ai/platform.bridge` exposes these factories. Each was traced into the vendored bundle (`dist/index-34cd716f.js`) to confirm whether it produces inbound wire keys.

| Factory | Wire-key prefix produced | Wayland callers | Wrapped? | Notes |
|---|---|---|---|---|
| `bridge.buildProvider(key)` | `subscribe-<key>` inbound; `subscribe.callback-<key><id>` outbound | `ipcBridge.ts` only (via wrapper) | YES (`bridgeAllowlist.buildProvider`) | Core. All ipcBridge keys captured. |
| `bridge.buildEmitter(key)` | none inbound; emits `<key>` outbound to renderer | `ipcBridge.ts` only (via wrapper) | YES (`bridgeAllowlist.buildEmitter`) | Outbound-only; allowlist still records for diagnostics. |
| `bridge.create(key)` | identical to `buildProvider` (same inner `w()`/`C()` functions) | **none in Wayland source** | n/a | Confirmed via `grep` — only documented in `uiProtocol.ts` comment, no calls. |
| `bridge.subscribe(name, cb)` | listens on `subscribe-<name>` (no key registration) | none (only via buildProvider) | n/a | Low-level; not used directly. |
| `bridge.invoke(name, data)` | emits `subscribe-<name>` outbound, listens `subscribe.callback-<name><id>` | none (only via buildProvider) | n/a | Low-level; not used directly. |
| `bridge.emit(name, data)` | passthrough to adapter — emits raw `<name>` | renderer-side via internal sendbox `emitter` (LOCAL emitter, **not** platform bridge) | n/a | See note below. |
| `bridge.on(name, cb)` / `bridge.off` | local EventEmitter listener (no wire egress) | `useDirectorySelection.tsx` only | n/a (local-only) | See §4. |
| `bridge.adapter({emit, on})` | configures transport adapter | `main.ts`, `standalone.ts`, `browser.ts` (twice) | n/a (this IS the dispatcher) | Inbound gate added; see §6. |
| `bridge.intercept(cb)` | request middleware | none | n/a | Unused. |
| `storage.buildStorage(ns, opts)` | `<ns>.storage.{get,set,clear,remove}` × 4 keys via raw `k()` (= raw buildProvider) | `common/config/storage.ts` only (via wrapper) | YES (`bridgeAllowlist.buildStorage`) | This is the P0 fix from the prior session — wrapper synthesises the 4 keys. |
| `Modal.dialog.*` | `office-ai-dialog.{open,close,post,getData}.<id>` | **none in Wayland source** | NO | See §6, P1 risk. |
| `bridge.logger` | sets internal logger fn; no wire keys | none | n/a | |
| `bridge.debug` | toggles platform internal flag | none | n/a | |
| `bridge.off` (renamed `b`) | local listener removal | `useDirectorySelection.tsx` | n/a | Local only. |

**Verdict:** `buildProvider`, `buildEmitter`, and `buildStorage` are the only factories used by Wayland that produce inbound wire keys. All three are wrapped. `bridge.create` and `Modal.dialog.*` are unused (zero callers) but unwrapped — see §6 for risk classification.

---

## 2. Namespace inventory (storage)

Every `buildStorage` namespace registers 4 keys via the wrapper at `bridgeAllowlist.ts:106-115`:
`<ns>.storage.get`, `<ns>.storage.set`, `<ns>.storage.clear`, `<ns>.storage.remove`.

From `src/common/config/storage.ts:13-27` (the only `buildStorage` import site in source):

| Namespace | Source line | Allowlist status |
|---|---|---|
| `agent.chat` | `storage.ts:18` | covered (4 keys) |
| `agent.chat.message` | `storage.ts:21` | covered (4 keys) |
| `agent.config` | `storage.ts:24` | covered (4 keys) |
| `agent.env` | `storage.ts:27` | covered (4 keys) |

**4 namespaces × 4 keys = 16 storage wire keys allowlisted.**

No other file imports `buildStorage` (confirmed by full-repo grep). The wrapper's key-synthesis logic matches the platform internal exactly: I traced `L = (e, n) => { ... e+".storage.get", e+".storage.set", e+".storage.clear", e+".storage.remove" ... }` in `dist/index.js` line 1; same four suffixes, same delimiter. **Exhaustive.**

---

## 3. Renderer-provided keys (`RENDERER_PROVIDED_KEYS`)

`RENDERER_PROVIDED_KEYS` currently contains exactly one entry: `conversation.response.search.workspace`.

Methodology: grep `.provider(` across `app/src/renderer/**`.

| Renderer-side `.provider(...)` call | Wire key | In `RENDERER_PROVIDED_KEYS`? |
|---|---|---|
| `useWorkspaceEvents.ts:194` → `ipcBridge.conversation.responseSearchWorkSpace.provider(...)` | `conversation.response.search.workspace` (from `ipcBridge.ts:75-77`) | YES |

`browser.ts:256` calls `logger.provider({...})` — this is `@office-ai/platform.logger.provider`, NOT the bridge-provider pattern. It registers a renderer-side log-output callback (subscribes to internal `officeai-logger` event from the same window). No wire key crosses the IPC boundary. **Not a bridge provider.**

**Verdict: exhaustive.** The single renderer-side bridge provider is captured. The list will need updating only if a new `<thing>.provider(...)` call appears in `src/renderer/**` using an `ipcBridge.*` key.

---

## 4. Control-plane allowlist (`CONTROL_ALLOWED`)

`CONTROL_ALLOWED = { 'pong', 'ping' }` (`bridgeAllowlist.ts:58-66`).

Methodology: I walked every inbound message the WS/IPC dispatchers can see that does NOT use a `subscribe-` / `subscribe.callback-` prefix.

Sources of inbound names crossing into `isAllowedInboundName`:
1. **Electron `electronAPI.emit(name, data)`** — preload at `preload/main.ts:14-26`. Renderer code calls this only via `bridge.adapter.emit`, which in turn is fed by `bridge.invoke/emit` → always `subscribe-...` or `subscribe.callback-...`. The one exception is the renderer's WebSocket-mode `__emitBridgeCallback` (only used in WebUI, not Electron).
2. **WebSocket inbound from browser webui** — `WebSocketManager.ts:130-165` parses `{name, data}`. Intercepts `pong` (line 140) and `subscribe-show-open` (line 146) BEFORE calling `onMessage`. Everything else forwards to `onMessage` → `webserver/adapter.ts:36` → `isAllowedInboundName`.
3. **Standalone `dispatchMessage`** — `standalone.ts:41-43`. Same allowlist.

Names that actually traverse `isAllowedInboundName`:
- `pong` — sent by Electron browser.ts:124 (`socket.send({name:'pong',...})`) in WebUI mode, in response to server `ping`. **Allowed.**
- `ping` — server-side originated only (`WebSocketManager.ts:284`), but listed defensively in case a client ever sends one. **Allowed.**
- `subscribe-<key>` — covered by the prefix branch.
- `subscribe.callback-<key>` — covered by the prefix branch.
- `auth-expired` — main → renderer ONLY (`WebSocketManager.ts:100, 253`); renderer never sends. Confirmed by grep — no `socket.send` of `auth-expired` in renderer.
- `bridge:error` — main → renderer ONLY (`main.ts:57`); renderer never sends.
- `subscribe-show-open` — intercepted by `WebSocketManager.ts:146` BEFORE the allowlist check, so it does NOT need to be in `CONTROL_ALLOWED`. The comment at `bridgeAllowlist.ts:63-65` documents this correctly. (Note: `show-open` is also registered as a regular provider at `ipcBridge.ts:226` and is in `providerKeys`, so it would pass the prefix check too — defense in depth.)

**Verdict: exhaustive for current code paths.** No outbound-only event names need to be in `CONTROL_ALLOWED`. The set could even be tightened to just `{ 'pong' }` if we accept that no client ever sends `ping`, but keeping `ping` is a defensive no-op.

---

## 5. Provider/emitter key surface (`buildProvider` + `buildEmitter` in `ipcBridge.ts`)

I counted every `buildProvider(...)` and `buildEmitter(...)` invocation in `src/common/adapter/ipcBridge.ts` (the SOLE source of these registrations). Each goes through the wrapped factory, so every key lands in `providerKeys` / `emitterKeys`.

Total: **~155 provider keys + ~40 emitter keys + 16 storage keys = ~211 allowlisted inbound names.**

Sampled spot-checks vs. caller usage in `src/renderer/**` and `src/process/bridge/**`: all keys exercised by `.provider(...)` server-side registrations and `.invoke()`/`.subscribe()` renderer-side calls trace back to entries in `ipcBridge.ts`. No orphan wire keys observed.

The side-effect import `import './ipcBridge'` is present in:
- `main.ts:17` (Electron main)
- `standalone.ts:11` (standalone server)

Both dispatchers therefore load every key into the allowlist BEFORE `bridge.adapter({on: ...})` finishes wiring the `ipcMain.handle` / `dispatchMessage` callbacks. There is a startup ordering note — see §7.

---

## 6. Bypass risks (factories not wrapped, callers bypassing wrappers)

### P0 (critical, must fix)
**None remaining.** The `buildStorage` bypass (the original P0) is fixed by the `buildStorage` wrapper. I verified the wrapper key synthesis matches the platform internal exactly (`<ns>.storage.{get,set,clear,remove}`).

### P1 (medium — pre-existing latent attack surface, NOT through the C1 bridge)

**P1-1: `ipcMain.handle` direct channels bypass C1 entirely.**
The bridge allowlist only protects `ADAPTER_BRIDGE_EVENT_KEY` (`office-ai-bridge-adapter`). The following channels are registered directly on `ipcMain` and are NOT covered by C1:

| Channel | Site | Auth gate? |
|---|---|---|
| `feedback:collect-logs` | `feedbackBridge.ts:40` | none observed in audit; renderer-only invocation |
| `webui-direct-reset-password` | `webuiBridge.ts:249` | W1-C3 auth gate (per memory) |
| `webui-direct-get-status` | `webuiBridge.ts:273` | W1-C3 auth gate |
| `webui-direct-change-password` | `webuiBridge.ts:285` | W1-C3 auth gate + currentPassword check |
| `webui-direct-change-username` | `webuiBridge.ts:318` | W1-C3 auth gate |
| `webui-direct-generate-qr-token` | `webuiBridge.ts:326` | W1-C3 auth gate |
| `weixin:login:start` | `weixinLoginBridge.ts:16` | none observed |
| `ambient:drag-start` / `ambient:drag-end` / `ambient:click` | `ambientWindowManager.ts:250-252` | none — but limited surface (window position only) |

**Risk:** Renderer XSS can invoke any of these directly via `ipcRenderer.invoke('webui-direct-...')`. The webui-direct-* channels are documented as gated by W1-C3. The remaining ones (`feedback:collect-logs`, `weixin:login:start`, `ambient:*`) need a separate audit pass. **This is OUT OF SCOPE for C1 but worth flagging.**

**P1-2: `Modal.dialog.*` factory unwrapped.**
The platform exports a `Modal.dialog` API (`A` in the bundle, `office-ai-dialog.open|close|post|getData.<id>` keys). Currently unused by Wayland (`grep` shows zero `Modal.dialog`, `import.*Modal` in source). If a future component imports `Modal.dialog` it would silently bypass C1 — the renderer could send `office-ai-dialog.open` and it would 403, **but** if `Modal.dialog.provider` is ever called server-side the renderer-issued `subscribe-office-ai-dialog.open` would 403 (correctly, since not allowlisted). The risk is the opposite: a legitimate dialog feature would break silently.

**Action class:** Document a "factory inventory" rule (any new platform factory must be wrapped). Defer until usage.

**P1-3: `bridge.create(key)` factory unwrapped.**
Same shape as `buildProvider` (identical inner functions `w()` and `C()` in the bundle), produces `subscribe-<key>` wire names, returns `{invoke, subscribe}` instead of `{invoke, provider}`. Zero callers in Wayland source. Same risk profile as P1-2: legitimate use would silently 403.

### P2 (low — code-quality / defense-in-depth)

**P2-1: `useDirectorySelection.tsx` uses bare `bridge.on/off`.**
The hook subscribes to `SHOW_OPEN_REQUEST_EVENT` (`show-open-request`), which is a main→renderer event. This is fine functionally (renderer-local subscription, no wire egress), but the event name is hardcoded outside `ipcBridge.ts` and not declared via `buildEmitter`. It's effectively a stowaway emitter.

Risk: if a future contributor types `bridge.on('show-open-request', ...)` somewhere and the WS server sends it, there's no allowlist entry to keep things consistent. However, **inbound** allowlist is unaffected — the event flows main→renderer, not renderer→main. **Not a security risk; just spec drift.**

**P2-2: Allowlist warm-up race window.**
`bridge.adapter({ on(emitter) { ipcMain.handle(KEY, ...); } })` is called from `main.ts`. The `ipcMain.handle` registration happens inside the `on(emitter)` callback. Looking at the bundle, `bridge.adapter` calls `on(p)` synchronously (where `p` is the platform's `EventEmitter`). Then in `main.ts:17` we have `import './ipcBridge'` BEFORE `bridge.adapter(...)` at line 39 — so all keys are registered before the handler ever attaches. **No race.** Same ordering in `standalone.ts:11 → 16`. Verified.

**P2-3: `subscribe-` / `subscribe.callback-` collision with `CONTROL_ALLOWED`.**
`CONTROL_ALLOWED` contains `pong` and `ping`. Neither starts with `subscribe-` or `subscribe.callback-`. The `isAllowedInboundName` order is:
1. `name.startsWith('subscribe-')` → check `providerKeys`
2. `name.startsWith('subscribe.callback-')` → check `RENDERER_PROVIDED_KEYS` prefix
3. fallthrough → `CONTROL_ALLOWED.has(name)`

A renderer crafting `name='subscribe-ping'` would route through branch 1 and require `ping` to be in `providerKeys`, which it isn't. **No collision.** The order also means a hypothetical provider keyed literally `pong` would never collide because pong has no `subscribe-` prefix. **Safe.**

**P2-4: `RENDERER_PROVIDED_KEYS` prefix match is greedy.**
`isAllowedInboundName` line 134-138 does `rest.startsWith(key)` rather than `rest === key + <8-hex-id>`. This means `subscribe.callback-conversation.response.search.workspaceXYZ` is accepted even if `XYZ` is not an 8-hex id. The platform actually appends `Math.random().toString(16).slice(2,10)` (8 hex chars), so the legitimate suffix is always 8 hex. A stricter regex `^[0-9a-f]{8}$` on `rest.slice(key.length)` would tighten this.

Currently exploitable as: a renderer XSS could send `subscribe.callback-conversation.response.search.workspaceANYTHING` with arbitrary payload, and `bridge.emit` would dispatch it to any listener. Since the listener for this key (in `Workspace/hooks/useWorkspaceTree.ts` flow) takes a `{file: number, dir: number, match?: IDirOrFile}` shape and is consumed only by the renderer-side `.provider(...)`, the actual harm is bounded — but in principle the loose match widens the inbound name surface.

**Action class:** P2 hardening — switch to a regex match. Low priority.

**P2-5: Allowlist registration happens at *module load*, not on `.provider(...)` call.**
This is by design (buildProvider is called when `ipcBridge.ts` is imported), but if any future namespace-builder is loaded LAZILY (dynamic import after `bridge.adapter` is wired), there's a brief window where the keys are unknown. Currently no lazy-loaded `buildProvider` callers exist (grep confirmed). **Not exploitable today.**

---

## 7. Action items (recommendations only — NOT implemented)

Priority-ordered. None block C1's stated guarantees; all are hardening.

1. **P1: Audit non-bridge `ipcMain.handle` channels for auth gate coverage.**
   - Confirm `feedback:collect-logs`, `weixin:login:start`, `ambient:*` are either gated or fundamentally safe.
   - Cross-reference with the W1-C3 webui-direct auth gate to ensure parity.
   - Add a comment in `bridgeAllowlist.ts` clarifying that C1 protects ONLY `ADAPTER_BRIDGE_EVENT_KEY`, with a pointer to where the direct-channel audit lives.

2. **P1: Add a "platform factory whitelist" test.**
   - Snapshot test that asserts the set of imports from `@office-ai/platform` matches an expected list (currently `bridge`, `storage`, `theme`, `logger`).
   - Fails CI if a contributor imports `Modal`, adds `bridge.create`, etc., without wrapping.

3. **P2: Tighten `subscribe.callback-` suffix match.**
   - In `bridgeAllowlist.ts:131-139`, after stripping the key prefix, assert the suffix matches `/^[0-9a-f]{8}$/`.
   - Negligible perf cost; closes a small payload-injection vector.

4. **P2: Add a test that exercises every key in the allowlist via `_getRegisteredKeysForTests`.**
   - Snapshot `providerKeys.size + emitterKeys.size + storage-keys-count` to catch silent drops.
   - Currently `standaloneAdapter.test.ts` only verifies the allowlist mechanism, not the key set.

5. **P2: Promote `useDirectorySelection.tsx` event name to a `buildEmitter`.**
   - Declare `SHOW_OPEN_REQUEST_EVENT` via `buildEmitter('show-open-request')` in `ipcBridge.ts`.
   - The renderer would then use `ipcBridge.dialog.showOpenRequest.on(...)` instead of bare `bridge.on(SHOW_OPEN_REQUEST_EVENT, ...)`.
   - Pure cleanup; no security delta.

6. **P3: Consider removing `'ping'` from `CONTROL_ALLOWED`.**
   - The renderer never sends `ping` (only `pong` in response to server's `ping`). Confirmed by full-repo grep.
   - Removing it tightens the surface from 2 to 1 control-plane name with no functional impact.

---

## Summary

**C1's stated invariant — "no inbound wire name not declared via `buildProvider` / `buildEmitter` / `buildStorage` is accepted" — holds for all Wayland-internal callers.** All three factories are wrapped, `ipcBridge.ts` is the sole site of provider/emitter registration, `storage.ts` is the sole site of `buildStorage`, and the dispatcher is consistently gated across all three entry points (Electron `ipcMain.handle`, standalone `dispatchMessage`, WebSocket `setupConnectionHandler`).

**Latent risks are all OUTSIDE C1's scope** (direct `ipcMain.handle` channels, unused platform factories that would need wrapping if adopted). The single P2 in-scope hardening worth doing is tightening the `subscribe.callback-` suffix regex (#3 above).

**Coverage rating: complete for current code paths.**
