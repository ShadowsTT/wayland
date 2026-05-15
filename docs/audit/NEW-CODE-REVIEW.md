# New-Code Review — feat/audit-hardening (11 files)

**Reviewed:** 2026-05-15
**Scope:** 11 new files added during the audit fix-swarm. Read-only; no code changed, no commits.

---

## src/process/bridge/webuiDirectAuth.ts (C3)

**Purpose:** Rate-limit and native-dialog auth gate for `webui-direct-*` IPC family.

**Strengths:**
- Sliding-window filter correct (stale entries dropped before queue).
- `dialog.showMessageBox` is the right unforgeable confirmation primitive.
- Empty-string password rejection before DB touch.

### [P0] Two `webui-direct-*` handlers have NO rate-limit guard

- **File:** `src/process/bridge/webuiBridge.ts:318`, `:326`
- **What could break:** `webui-direct-change-username` and `webui-direct-generate-qr-token` register without any `enforceRateLimit` call. A compromised renderer can rotate the admin username silently or farm QR tokens for session hijack — no throttle.

```ts
// :318 — no enforceRateLimit
ipcMain.handle('webui-direct-change-username', async (_event, { newUsername }) => { … });
// :326 — no enforceRateLimit
ipcMain.handle('webui-direct-generate-qr-token', async () => { … });
```

The three guarded handlers (lines 249-250, 273-274, 288-289) all open with `if (!enforceRateLimit(...)) return AUTH_ERROR_RATE_LIMITED;`.

**Fix:** Add the same guard as the first statement of each missing handler.

**File-path note:** review brief said `src/common/adapter/webuiDirectAuth.ts`. Real path is `src/process/bridge/webuiDirectAuth.ts` — correct placement (uses Electron `dialog`/`BrowserWindow`).

---

## src/renderer/utils/sanitize.ts (H3)

**Purpose:** DOMPurify wrappers for raw-HTML sinks.

**Strengths:** Three purpose-specific helpers; all six current call sites verified correct; `MermaidBlock.tsx` uses `ADD_TAGS`/`ADD_ATTR` as documented.

### [P1] `...extra` spread can silently replace `USE_PROFILES`

- **File:** `src/renderer/utils/sanitize.ts:24-25`, `:31-32`, `:38-39`
- **What could break:** Future call site like `sanitizeHtml(content, { USE_PROFILES: { svg: true } })` overwrites the base HTML profile silently. No current call site does this; the type system doesn't prevent it.

```ts
return DOMPurify.sanitize(input, {
  USE_PROFILES: { html: true },
  ...extra,   // overwrites if caller supplies USE_PROFILES
});
```

**Fix (type-level):** `extra?: Omit<Config, 'USE_PROFILES'>`. Zero runtime cost, compile error on misuse.

---

## src/process/utils/atomicWrite.ts (M16)

**Purpose:** Tmp+rename atomic write.

**Strengths:** Tmp-then-rename is correct; unique tmp name (`pid + Date.now()`); both sync and async covered.

### [P1] Tmp file never unlinked on rename failure

- **File:** `src/process/utils/atomicWrite.ts:33-34` (async), `:43-44` (sync)
- **What could break:** On EXDEV (cross-filesystem), disk-full, or permissions error during `rename`, the `.tmp-<pid>-<ts>` file orphans. Worst case is disk-full: each failed write leaves an orphan that consumes the same disk space that caused the failure.

```ts
const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
await fs.writeFile(tmp, data, opts);
await fs.rename(tmp, targetPath);  // throws, tmp orphaned
```

**Fix:**
```ts
try { await fs.rename(tmp, targetPath); }
catch (err) { await fs.unlink(tmp).catch(() => {}); throw err; }
```

---

## src/process/webserver/auth/repository/TokenBlacklistRepository.ts (L8)

**Strengths:** Migration v29 verified; `INSERT OR REPLACE` correct; `pruneExpired` returns change count; no silent swallows.
**Findings:** None above threshold.

---

## src/process/webserver/auth/service/bcryptSemaphore.ts (M1)

**Strengths:** Fast-fail (no queue) is the correct design; `try/finally` guarantees decrement; `BcryptBusyError` carries `retryAfterSeconds`; `setBcryptMaxConcurrent` validates input.
**Findings:** None above threshold. Single-threaded JS, no race on counter.

---

## src/process/webserver/i18n/qrLogin.ts (M20)

**Strengths:** q-value parsing; primary-subtag fallback (`zh` → `zh-CN`); `q <= 0` skipped per RFC 9110; locale entries are spread copies.
**Findings:** None above threshold.

---

## src/renderer/components/ErrorBoundary.tsx (H13)

**Strengths:** Correct two-phase lifecycle; logs to `electron-log/renderer`; `reset` threaded to custom fallback.

### [P2] Default fallback renders raw `error.message` in `<pre>` — info leak in prod

- **File:** `src/renderer/components/ErrorBoundary.tsx:36`
- **What could break:** `error.message` can include file paths and module identifiers. Low severity for desktop but exposes structure to anyone triggering a renderer crash via crafted LLM output.

```tsx
<pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.error.message}</pre>
```

**Fix:** Gate on `process.env.NODE_ENV === 'development'` or make default fallback minimal (reset button only, no message).

---

## src/common/adapter/bridgeAllowlist.ts (C1)

**Strengths:** `buildStorage` covers all 4 sub-keys; `isAllowedInboundName` handles 3 wire shapes; `RENDERER_PROVIDED_KEYS` is `ReadonlySet` with explicit maintenance comment; non-string/empty guards; `options` overload preserves typing.
**Findings:** None above threshold.

---

## src/process/extensions/protocol/assetAllowlist.ts (C2)

**Strengths:** Set-dedup of roots; delegates to `isPathWithinDirectory` (appends `path.sep` — prevents `/home/ext` vs `/home/ext-evil`); `realpathSync.native` catches symlink escape; returns `null` not throw; URL-decode happens upstream at Electron protocol layer.
**Findings:** None above threshold.

---

## src/vendor/pptx2json/index.js (M22)

**Strengths:** Full file verified — zero `require()`, zero `module.exports`, zero `__dirname`; MIT LICENSE present with upstream copyright; `Promise.all` parallel extraction; `JSZip()` without `new` is valid v3 syntax (upstream cosmetic inconsistency).
**Findings:** None above threshold.

---

## tests/e2e/specs/security-audit-verification.e2e.ts

**Strengths:** Independent tests; `test.skip` entries each cite the commit SHA — honest gap accounting; C2 covers 3 traversal patterns including `//etc/passwd`; C1 test validates both rejection AND allowlisted-success paths.
**Findings:** None above threshold.

---

## Cross-cutting observations

- **Rate-limit coverage is the highest-priority issue.** C3 exists to gate the family uniformly, yet 2 of 5 handlers shipped without calling it. No structural enforcement. Consider a factory wrapper that makes the rate-limit call mandatory.
- **`sanitize.ts` caller contract is implicit.** `Omit<Config, 'USE_PROFILES'>` would close the override path at zero cost.
- **`atomicWrite` orphan is low-probability but correct to fix.** Cross-FS rename is uncommon in this app's deployment context, but disk-full conditions can fail rename after successful write — precisely when orphaning is most costly.
- **No unit tests for 3 new security-critical modules:** `bcryptSemaphore`, `assetAllowlist`, `webuiDirectAuth`. AGENTS.md states ≥80% coverage target. Edge cases untested.
