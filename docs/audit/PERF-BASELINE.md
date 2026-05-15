# PERF-BASELINE — Wayland v0.1.2-wayland-base

**Phase 2, dimension J — Performance baseline (informational, read-only).**

**Repo:** `/Users/seandonahoe/dev/wayland/app`
**Branch / HEAD:** `feat/audit-hardening @ a30d77dba`
**Build artifact:** `out/` from `electron-vite dev` build at 2026-05-15 13:49 PDT
**Platform:** macOS Darwin 25.3.0, Apple Silicon, Electron 41.6.0 / Chromium 146.0.7680.216 / V8 14.6.202.34
**Measured:** 2026-05-15 (dev build; `bun run start`)

> NOTE ON BUILD FLAVOR. The renderer chunks under `out/renderer/assets/` were produced by `electron-vite` with the default `dev`-build pipeline, which still runs Rollup with code-splitting and minification (`vite build` semantics) into the `out/` directory the orchestrator's last build wrote. These are minified but **not packaged into an asar bundle** and **not stripped of source-maps' Sentry release tags**. Numbers are representative; a production `dist` build will be marginally smaller (asar packing + tree-shaking dead imports), but the chunk shape will be the same.

---

## Headline numbers

| Metric                                   | Value                              |
|------------------------------------------|------------------------------------|
| Renderer JS total (431 chunks)           | **17.56 MB minified**              |
| Main renderer chunk (`index-*.js`)       | **1,505,001 B ≈ 1.44 MB minified** |
| Chunks > 250 kB                          | **14**                             |
| Chunks > 500 kB                          | **8**                              |
| Cold start, run 1 (clean caches)         | 15,337 ms                          |
| Cold start, run 2 (warm vite/esbuild)    | 6,755 ms                           |
| Cold start, run 3 (warm)                 | 5,148 ms                           |
| Cold start, **3-run median**             | **6,755 ms** (warm dev-mode)       |
| Cold start, run-1 absolute               | **~15.3 s** (cold disk + bun fresh)|
| Idle memory — main process RSS           | **475 MB** (485,952 KB)            |
| Idle memory — main + helpers total RSS   | **937 MB** (959,824 KB, 4 procs)   |
| IPC round-trip median (renderer→main→renderer) | **0.1 ms** (N=500)            |
| IPC round-trip p95 / p99 / max           | 0.2 / 0.2 / 0.6 ms                 |

---

## 1. Bundle inventory — chunks > 250 kB

Sourced from `out/renderer/assets/`. All sizes are minified (not gzipped).

| Rank | Chunk                                        | Size       | Likely content (inferred from strings + Rollup naming) |
|-----:|----------------------------------------------|-----------:|--------------------------------------------------------|
| 1    | `index-_q8QsLR8.js`                          | 1,505,001  | **Main renderer entry**: React tree, app routes, react-router, react-i18next, react-markdown, streamdown, hot-path UI components. No Sentry, no Mermaid, no Katex (those are split). |
| 2    | `vendor-highlight-CECMyMF8.js`               |   916,486  | `react-syntax-highlighter` + bundled language definitions (refractor/prismjs core). |
| 3    | `emacs-lisp-C9XAeP06.js`                     |   779,854  | shiki/highlight-lazy grammar for emacs-lisp (single-language async chunk). |
| 4    | `vendor-arco-BrH1yDwW.js`                    |   674,712  | `@arco-design/web-react` component library (matches arco-specific identifiers: `actionList`, `addAfter`, `afterClose`, etc.). |
| 5    | `cpp-CofmeUqb.js`                            |   626,081  | Tree-sitter/shiki C++ grammar (async). |
| 6    | `wasm-CG6Dc4jp.js`                           |   622,336  | Base64-embedded **WebAssembly module** (heuristic: leading `var Q=Ui...` then long base64 segments; ~likely `web-tree-sitter` runtime). |
| 7    | `vendor-editor-DS64qO2_.js`                  |   616,568  | **CodeMirror / @uiw/codemirror** — strings `@charset`, `@font-face`, `@keyframes`, `@scope` (CSS/HTML lang extension dictionaries). |
| 8    | `MermaidBlock-BhM2NPpi.js`                   |   604,156  | Mermaid diagram block component + core mermaid wrapper (`mermaid-mWjccvbQ.js` is a peer chunk). |
| 9    | `vendor-arco-Bfxep3p_.css`                   |   569,488  | Arco CSS bundle (not JS, but inflates first paint). |
| 10   | `treemap-KZPCXAKY-CQP_7Z2q.js`               |   453,411  | Mermaid treemap renderer. |
| 11   | `cytoscape.esm-C-N-7XAP.js`                  |   442,416  | Cytoscape graph library (Mermaid architecture diagrams). |
| 12   | `index-CPqvQHaG.js`                          |   433,373  | **Sentry SDK** (`@sentry/electron` renderer half + `@sentry/browser`) — strings `addBreadcrumb`, `addEventProcessor`, `addFeatureFlag`, `abnormal_mechanism`, `active_thread_id`. |
| 13   | `vendor-markdown-qWAKlTUN.js`                |   373,919  | `react-markdown` + `remark-*` + `rehype-*` + `unified` ecosystem. |
| 14   | `wolfram-lXgVvXCa.js`                        |   262,391  | Wolfram-language grammar (shiki async). |
| 15   | `vendor-katex-DrSI9qtO.js`                   |   258,835  | Katex full bundle. |
| 16   | `vendor-react-CnqNPmaT.js`                   |   222,813  | React 19 + ReactDOM (single copy). |

(Chunks 17–28 are mostly per-language syntax grammars, each 100–210 kB, all lazy.)

**Chunk count by category:**
- Per-language syntax/grammar chunks: ~50+ (cpp, ts, jsx, php, blade, racket, …) — these are async-loaded only when a fenced code block of that language is rendered.
- Vendor splits: arco, react, highlight, editor, markdown, katex (good — these are the right seams).
- Single big eager chunk: `index-*.js` at 1.44 MB minified — too large.

---

## 2. Cold-start time

Measured from `bun run start` invocation to first `Renderer did-finish-load` log line, via the Electron main process console.

```
RUN 1: 15,337 ms  (cold OS file cache, fresh bun + vite + esbuild)
RUN 2:  6,755 ms  (warm OS cache, esbuild pre-bundle cached)
RUN 3:  5,148 ms  (fully warm)
```

**3-run median: 6,755 ms (~6.8 s) warm dev-mode.**

**Caveats:**
- This is `electron-vite dev`, not a packaged production app. Production `dist` builds are typically 1.5–2x faster because the renderer loads a pre-built bundle (no Vite HMR server boot).
- The run-1 outlier (~15s) is dominated by Vite pre-bundling deps and esbuild spawning. For an end-user cold launch of the `.app`, expect 2–4 s on M-series hardware once asar-packed.
- "did-finish-load" is when the renderer DOM is ready, not when the app is fully interactive. App-interactive time (chat list rendered, auth state hydrated) is typically 1–2 s after that based on the perf log.

---

## 3. Idle memory

Captured ~10 s after window-shown, while the app sat idle on the default route (`#/guid`).

```
Main process     (pid 22297): 486,800 KB ≈ 475 MB RSS
GPU helper       (pid 22446): 103,248 KB ≈ 101 MB RSS
Network helper   (pid 22447):  72,304 KB ≈  71 MB RSS
Renderer helper  (pid 22471): 297,472 KB ≈ 290 MB RSS
-----------------------------------------------------
TOTAL (4 procs):              959,824 KB ≈ 937 MB
```

**Main + total: 475 MB / 937 MB.**

For comparison:
- VS Code idle (one window, no extensions): ~250–400 MB total.
- Slack idle: ~600–900 MB total.
- Discord idle: ~400–700 MB total.

Wayland sits at the high end of the Electron-app idle range. The bulk is in the main process (475 MB) — much higher than typical (usually 150–250 MB). Likely contributors:
- `better-sqlite3` native module + DB pages held in main-process RSS.
- `@google/genai`, `@anthropic-ai/sdk`, `openai`, `@aws-sdk/client-bedrock` SDKs all loaded at startup in main (each pulls a transitive tree).
- Sentry-electron main-side queue + transport.
- `@office-ai/aioncli-core` + `@modelcontextprotocol/sdk` always-loaded.

The renderer at 290 MB is normal for a React app with arco + monaco/codemirror + react-markdown loaded.

---

## 4. IPC round-trip latency

Measured via Chrome DevTools Protocol against the live renderer (port 9230), executing `await window.electronAPI.webuiGetStatus()` 500 times in serial and timing each call with `performance.now()` inside the renderer.

```
N:               500
Target:          webui-direct-get-status (ipcRenderer.invoke → ipcMain.handle)
renderer_ms:
  min:     0.000
  median:  0.100   <-- HEADLINE
  mean:    0.076
  p95:     0.200
  p99:     0.200
  max:     0.600
cdp_overhead_median_ms: 0.257 (additional latency the CDP loop added; not part of IPC)
```

**Median IPC round trip: 0.1 ms.** This is excellent — the bridge layer is not a bottleneck. Any user-perceived "IPC slowness" is downstream of the handler (DB query, network call, fs read), not in the contextBridge wire itself.

Bench script saved at `/tmp/ipc-latency.mjs` for re-running.

---

## 5. Bundle analysis observations

### Duplicate-dep check
- **React: single copy** (`vendor-react-CnqNPmaT.js`, 223 kB). Main index chunk grep'd negative for a second React. No dedupe needed.
- **Sentry: single split chunk** (`index-CPqvQHaG.js`, 433 kB). Code-split correctly but loaded eagerly — see "Quick wins".
- **Mermaid: split per-diagram-type.** Core `mermaid-mWjccvbQ.js` plus per-diagram chunks (`architectureDiagram`, `sequenceDiagram`, `treemap`, `c4Diagram`, `blockDiagram`, …). Good.
- **No duplicate markdown stack.** Single `vendor-markdown-*` chunk.
- **No duplicate arco.** Single 675 kB vendor split.

### Smell checks
- The **main `index-_q8QsLR8.js` at 1.44 MB** is the biggest leverage point. It mixes routes, React app shell, and several heavy components that should be lazy.
- The **base64-embedded WebAssembly chunk (`wasm-*.js`, 622 kB)** is preload-cost waste. Browsers can stream-compile a `.wasm` file fetched as a binary asset much faster than a 622 kB JS file containing a base64 string the runtime must decode. This is a Vite/Rollup configuration choice — almost certainly the `?init` import pattern with inlining enabled.
- **`react-syntax-highlighter` at 917 kB minified** is enormous. The default import pulls every language. Project uses streamdown / `react-syntax-highlighter`, which can be configured to only register languages on demand, or replaced with shiki (which the project also seems to ship, given the per-language async chunks). Looks like *both* shiki and react-syntax-highlighter are bundled — that's a likely duplication, worth verifying.
- **CodeMirror / monaco confusion.** `@monaco-editor/react` AND `@uiw/react-codemirror` are both in `package.json`. The 617 kB `vendor-editor` chunk reads as CodeMirror-CSS-grammar. If monaco isn't being used, it's dead weight; if both are used in different surfaces, neither can be removed but the lazy boundaries should be tightened.
- **`vendor-arco-*.css` at 569 kB** dwarfs most JS chunks. Arco ships a single CSS bundle and tree-shaking it is non-trivial; this is the biggest CSS cost.

### Things that are good
- **Per-language grammar lazy chunks.** Renderer doesn't pay for "fortran-free-form" parser until someone pastes Fortran. Good architecture.
- **Mermaid diagram-type splitting.** Treemap/architecture/c4 each isolated.
- **React, arco, markdown, katex** all live in their own vendor chunks.

---

## 6. Quick wins (recommended, not implemented)

Ranked by effort-to-payoff. **No code changes made.**

1. **Lazy-load Sentry (`index-CPqvQHaG.js`, 433 kB)** — initialize Sentry behind `requestIdleCallback` or after the first user interaction. Saves 433 kB on the critical-path. Sentry-electron supports deferred init; the renderer SDK is ~75% of the chunk. *Effort: ~1 hour. Saves: ~400 kB parse/load, possibly 200–500 ms cold-start.*

2. **Switch WASM inlining off.** Change Vite config to emit `wasm` chunks as `.wasm` assets (not base64-in-JS). 622 kB minified JS → ~400 kB binary `.wasm` that streams-compiles. *Effort: 30 min config change. Saves: ~600 ms parse on cold start.*

3. **Pick one editor.** Either `@monaco-editor/react` or `@uiw/react-codemirror`, not both. CodeMirror is already the heavier of the two in this build. *Effort: depends on usage breadth; could be 2–8 hours. Saves: ~300–600 kB if monaco is removable, ~617 kB if codemirror is removable.*

4. **Trim `react-syntax-highlighter`.** Either:
   - Use `react-syntax-highlighter/dist/esm/light` with only the languages the app needs (Wayland is an AI chat — Python, JS/TS, JSON, Bash, SQL, Markdown probably covers 95%), OR
   - Drop it entirely in favor of shiki (already present per the per-language async chunks).
   *Effort: 1–3 hours. Saves: ~500–800 kB of the 917 kB chunk.*

5. **Code-split the main `index-*.js`.** 1.44 MB is too big. Audit imports in `src/renderer/main.tsx` and root route component — anything that's only used in a single page (settings, channel-modal, MCP debugger UI) should be `React.lazy()`. *Effort: 2–4 hours. Saves: ~400–700 kB off the critical-path chunk.*

6. **Investigate main-process RSS at 475 MB.** Run `node --inspect` on the main process, take a heap snapshot, identify which SDK / module is holding the most. Likely candidates: `@aws-sdk/client-bedrock` (~30 MB on its own), the Google + Anthropic + OpenAI SDKs (~20 MB each transitively), better-sqlite3 page cache. Lazy-load SDKs only when their provider is selected. *Effort: 4–8 hours. Saves: potentially 100–200 MB of idle RSS.*

7. **Defer `mermaid` core until a diagram is rendered.** Currently `MermaidBlock` is its own 604 kB chunk (good), but if `mermaid-mWjccvbQ.js` is eagerly preloaded from a `<link rel="modulepreload">` in `index.html`, that's wasted bandwidth for users who never paste Mermaid. *Effort: 30 min audit. Saves: ~400 kB preload cost.*

---

## 7. Methodology notes

- **Cold start:** `bun run start` (electron-vite dev mode). Killed all electron processes, waited 2 s, started timer, polled `/tmp/wayland-perf-*.log` for the literal string `"Renderer did-finish-load"`, recorded elapsed wall time. Repeated 3 times.
- **Idle memory:** After window shown + 10 s settle, `ps -o rss= -p <pid>` summed across the main + GPU + Network + Renderer-helper processes that matched `wayland/app/node_modules/electron/dist/Electron.app`.
- **IPC latency:** Connected over the renderer's CDP WebSocket at `ws://127.0.0.1:9230/devtools/page/<id>`, called `Runtime.evaluate` with an async expression that awaited the bridge call and reported `performance.now()` delta. CDP overhead measured separately (subtracted out, was 0.257 ms median).
- **Bundle sizes:** Direct `ls`/`stat` on `out/renderer/assets/`, no gzip applied. Content inference: grep'd for distinctive strings (package names, well-known function names) inside each chunk. No bundle-analyzer visualization was generated; the size deltas and string fingerprints are unambiguous for the top 16 chunks.

**Bench artifact:** `/tmp/ipc-latency.mjs` (re-runnable WebSocket+CDP probe).
**Log artifacts:** `/tmp/wayland-perf-{1,2,3}.log`.

---

## 8. Phase 2-J Q5 — Lazy AI SDKs (shipped 2026-05-15)

**Change shipped:** All four AI provider SDKs (`@anthropic-ai/sdk`, `@google/genai`, `openai`, `@aws-sdk/client-bedrock`) converted from eager top-level imports to single-flight Promise-cached dynamic imports. Plus cron-aware pre-warm so scheduled jobs don't pay the lazy-load latency on first fire.

**Files:**
- `src/common/api/AnthropicRotatingClient.ts`
- `src/common/api/GeminiRotatingClient.ts`
- `src/common/api/OpenAIRotatingClient.ts`
- `src/process/bridge/modelBridge.ts`
- `src/process/utils/prewarmProviders.ts` (new)
- `src/process/utils/initBridge.ts` (pre-warm wiring)

**Pattern:** `import` → `import type` for the SDK module; module-level `let _ctorPromise: Promise<typeof SDK> | null` cache; `loadX()` helper exported per SDK for the pre-warmer. For `Rotating*Client` classes (which extend `RotatingApiClient` whose constructor invokes `createClientFn` synchronously), a `configHolder: { current: ... | null }` pattern captures resolved SDK config sync; `ensureRealClient()` materializes the real SDK instance on first call (and after key rotation). For `modelBridge.ts`, SDKs are constructed inline inside async probe handlers — just `const Ctor = await loadX(); new Ctor({...})`.

**Pre-warm:** After `cronService.init()` resolves at boot, the loader for each in-process-SDK backend (currently just `gemini` → `loadGoogleGenAI`) is invoked. ACP CLI backends spawn external binaries and don't trigger SDK loads — they're skipped silently.

### Measured delta (same machine, same methodology as §3)

| Process | Before (475 MB baseline run) | After (lazy SDKs) | Δ |
|---|---:|---:|---:|
| **Main process RSS** | **475 MB** | **354 MB** | **−121 MB (−25%)** |
| GPU helper | 101 MB | 95 MB | −6 MB |
| Network helper | 71 MB | 65 MB | −6 MB |
| Renderer helper | 290 MB | 269 MB | −21 MB |
| **Total (4 procs)** | **937 MB** | **781 MB** | **−156 MB (−17%)** |

Cold-start time and IPC latency unchanged (the SDK imports were never on the critical path to `Renderer did-finish-load` — the lazy-load defers what was being held *after* boot, not what was being imported *during* boot).

**Caveat:** measured on a dev DB with no enabled cron jobs, so the pre-warm did not fire any loaders. With cron jobs that reference `gemini`, expect main RSS to be ~25 MB higher (the `@google/genai` SDK gets pre-loaded). Other SDKs still stay lazy unless cron references them or the user manually triggers a provider call.

### Other Phase 2-J quick wins shipped earlier in the audit

| Win | Status |
|---|---|
| (Q1) Lazy Sentry main-init when `VITE_SENTRY_DSN` set | shipped — commit `da1f173cc` |
| (Q2) WASM extracted out of base64-in-JS to sidecar `.wasm` | shipped — commit `100bf8aac` |
| (Q4) `react-syntax-highlighter` lazy per-language chunks | shipped — commit `38f7d9537` |
| (Q5) Lazy AI SDKs in main process | shipped — this section |

(Q3 — pick one of `@monaco-editor/react` / `@uiw/react-codemirror` — deferred. Both are used in different surfaces; not a clean win.)

---

**End of PERF-BASELINE.**
