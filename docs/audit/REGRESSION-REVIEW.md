# Regression Review — feat/audit-hardening (75 commits)

**Branch:** `feat/audit-hardening`
**Range:** `v0.1.2-wayland-safety` (a74cb443) → HEAD (4b9634897)
**Reviewed:** 2026-05-15
**Findings:** 2 P0, 1 P1 (confidence ≥ 80)

Only HIGH-CONFIDENCE findings reported. The two known P0s already fixed (a4b196a73 pptx2json ESM, 4b9634897 storage allowlist) are verified complete. Findings below are NEW silent regressions introduced by the audit chain itself.

---

## [P0] CSRF middleware always throws — entire WebUI broken for state mutations

- **Commits:** `5bbdd3d96` (drop hardcoded cookie-parser secret) + `fcbe340f5` (CSRF wiring)
- **File:** `src/process/webserver/setup.ts:52`

**What could break:** Every POST/PUT/DELETE/PATCH that is NOT in the exclusion list (`/login`, `/api/auth/qr-login`, `/channels/wecom/webhook`) throws a 500 CSRF error at runtime. Logout, change-password, refresh, upload, STT — all broken in WebUI mode.

**Evidence:**

`setup.ts:52` calls `cookieParser()` without a secret argument. tiny-csrf stores and reads its CSRF token as a **signed** cookie (`cookieParams.signed = true` in its internals). cookie-parser only populates `req.signedCookies` when initialized with a secret. Without one, `req.signedCookies` is always `{}`.

`node_modules/tiny-csrf/index.js:43-52`:
```js
const { csrfToken } = req.signedCookies;   // always undefined
if (csrfToken != undefined && verifyCsrf(...)) {
  ...
} else {
  throw new Error(`Did not get a valid CSRF token...`);  // always throws
}
```

The comment in `setup.ts:49-51` rationalizes "No signed cookies are issued anywhere…" — true for the app's own cookies, but wrong about tiny-csrf, which depends on signed cookies as its transport.

**Suggested fix:** `app.use(cookieParser(CSRF_SECRET))`.

---

## [P0] `uploadFileViaHttp` sends CSRF as `x-csrf-token` header; tiny-csrf only reads `req.body._csrf`

- **Commit:** `fcbe340f5`
- **File:** `src/renderer/services/FileService.ts:40`

**What could break:** Even after the signed-cookie issue is fixed, `POST /api/upload` will still fail CSRF validation. tiny-csrf does not read headers.

**Evidence:**

`FileService.ts:31-40`:
```ts
xhr.setRequestHeader(CSRF_HEADER_NAME, csrfToken);  // header path
```

`tiny-csrf/index.js:46`:
```js
verifyCsrf(req.body?._csrf, csrfToken, secret)  // body only
```

A multipart `FormData` body never includes `_csrf` as a field. The header is silently ignored. The comment in `csrfClient.ts:117-118` even acknowledges this — but FileService uses the header path anyway.

**Suggested fix:** Replace `xhr.setRequestHeader(...)` with `formData.append('_csrf', csrfToken)`.

---

## [P1] Sentry renderer initializes with NO `beforeSend` scrubber — PII leaks

- **Commits:** `6cf1aa5d3` (Sentry PII scrub), `c9bc0c27c` (tighten signature)
- **File:** `src/renderer/main.tsx:15`

**What could break:** Renderer-captured stack traces, exception messages, and breadcrumbs (which touch chat text, file paths, settings) are forwarded to Sentry unfiltered. The `scrubPii` is only wired into the MAIN process.

**Evidence:**

`src/index.ts:24-65` — main has `Sentry.init({ dsn: ..., beforeSend: scrubPii })`.
`src/renderer/main.tsx:15` — renderer has only `Sentry.init();` — no config.

The renderer process runs as the same OS user; stack frame filenames contain the real home directory. `scrubPii` has no Electron-specific imports and is safe to use from the renderer.

**Suggested fix:** Extract `scrubPii` to a shared module (e.g., `src/common/utils/sentryPii.ts`) and apply it in both Sentry inits.

---

## Verified clean (high-risk commits checked, no further findings)

- **fb705cde3** (WebSocketManager buffer/handler race) — pattern correct, race closed
- **b59e4340f** (`disposeAllTeamSessions` → Promise.allSettled) — correct, no swallow
- **4b9634897** (storage allowlist P0) — wrapper covers all 4 keys
- **a4b196a73** (pptx2json ESM) — clean ESM, no leftover `require`
- **69e5c632e** (token blacklist persistence) — fails soft on DB error, explicit logging
- **d440968f6** (Windows shell injection) — `execFile` + URL validation, no shell expansion
- **3f81c9cbb** (zod input validation) — schemas match production payloads
- **6cf1aa5d3** (main-process scrubPii) — correct (gap is renderer-side, P1 above)
- **fcbe340f5** (CSRF wiring) — route registration consistent (but the guard itself is broken — P0 above)

---

## Files referenced

- `src/process/webserver/setup.ts:52` — P0 root cause
- `node_modules/tiny-csrf/index.js` — confirms signed-cookie dependency (lines 4-8, 43-52)
- `src/renderer/services/FileService.ts:31-40` — P0 upload path
- `src/renderer/main.tsx:15` — P1 renderer Sentry init
- `src/index.ts:24-57` — main-process scrubPii reference
