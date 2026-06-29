# Concierge — Session Handoff (live state)

**Date:** 2026-06-29 · **Branch:** `feat/concierge` · **PR:** [#439](https://github.com/FerroxLabs/wayland/pull/439) (OPEN → `main`) ·
**Worktree:** `/private/tmp/wt-concierge` · **gh:** FerroxLabs · **push remote:** `ferrox` · **commit:** `e52f16a70`

Read order: this file → `CONTRACT.md` (§2b) → `CONCIERGE-SPEC.md` → `AUDIT-2026-06-29-phase1-2a.md`.

---

## 1. HONEST STATUS — ~68%, NOT done

Code is written and **unit-green**, but "green tests" ≠ "it works." What is and isn't actually verified:

| Layer | Built | Unit-tested | Cross-audited | LIVE-verified in app |
|---|---|---|---|---|
| Phase 1 — knows | ✅ | ✅ | ✅ (re-audit: go) | ❌ (panel/settings DOM not yet) |
| Phase 2a — diagnoses | ✅ | ✅ | ✅ (re-audit: go) | ❌ (packaged subprocess spawn unproven) |
| Phase 2b — acts | ✅ | ✅ (detector/bridge/card) | ⏳ **in flight** (`wf_6664cfc0-f24`) | ❌ (NO agent-turn test) |

**The gaps that make it 68%, not 100%:**
- **2b was built AFTER the last re-audit → never adversarially audited until now** (cross-audit `wf_6664cfc0-f24` is running; act on its verdict).
- **Nothing has been live-verified in a running app.** No "what can you do?" turn, no real `[CONCIERGE_PROPOSE]` → card → apply, no packaged diag-subprocess spawn. Local harness cannot run wcore agent turns (see memory `local-harness-cannot-run-wcore-tasks`) → route live agent-turn verification to **Overwatch/Windows**.
- **Open fast-follows** (flagged in PR #439): diag persona-gating + 3 low redaction refinements (SEC-1/SEC-2/NR-1); residual coverage (initStorage seed path, Gemini/ACP-native wiring tests).

**Highest-risk unknowns the cross-audit + live-verify must resolve (could be e2e-breaking):**
1. Is the `concierge_propose` message **persisted** (addMessage) and not just broadcast? If not, `getMessageByMsgId` at accept → `message_not_found` and **accept always fails**.
2. Does the renderer's inbound `responseStream` path actually **render** a `concierge_propose` message, or is there a message-type allowlist that only knows `cron_propose`?
3. Is `processAgentResponse` actually **called** on completed wcore/ACP turns (so the detector ever fires)?
4. Does the card **update** on the bridge's status-change broadcast?

These are exactly what the running cross-audit is checking; do not assume they pass.

---

## 2. What was built (PR #439, commit e52f16a70, 91 files, +6405/−46)

**Phase 1 (knows):** `CapabilitiesManifest.ts` (skill-only count, provider/workflow cache key, sanitizeToken); `agentUtils.ts` (`isCapabilityIntent` noun-anchored, `resolveCapabilitiesManifest`, `resolveTurnCapabilityAdvert`, `concierge.capabilityInjection` kill-switch); manifest injected in 3 assemblers + ACP native branch; `concierge` preset (front door); `WaylandCapabilitiesPanel` (no "out of 0", whyDidntRun gated, dismiss); Settings toggle (`concierge.defaultPersona`); 12-locale i18n.

**Phase 2a (diagnoses):** `conciergeDiagServer.ts` (+entry) read-only MCP, hardened redact() (key-name + URL/DSN + shape + home scrub + stderr observability); `build-mcp-servers.js` marks `better-sqlite3` external (the critical native-binding fix — proven via `conciergeDiagBundle.test.ts`); registration (constants, initStorage seed, asarUnpack, mcpScriptDir).

**Phase 2b (acts):** `src/common/chat/conciergeConfig.ts` (contract) · `ConciergeProposeDetector.ts` · `MessageMiddleware.ts` `handleConciergeProposals` · `chatLib.ts` `concierge_propose` type+mapping · `ipcBridge.ts` `conciergeConfig.confirmProposal` · `conciergeConfigBridge.ts` (MAIN apply: auth + pending-only + atomic + 4 write paths) · `ConciergeConfigCard.tsx` (+css) · `MessageList.tsx` mapping · `fsBridge.writeAssistantRules` · persona block-format docs.

**Tests (new):** conciergeProposeDetector (9) · conciergeConfigBridge (10, incl. no-accept-never-writes) · ConciergeConfigCard.dom (5) · plus Phase1/2a suites. Full suite green, tsc exit 0, lint 0 errors, i18n pass.

---

## 3. NEXT SESSION — verify, don't re-build

1. **Read the 2b cross-audit result** (`wf_6664cfc0-f24` output) and fix every confirmed e2e-breaking / blocking finding. Especially the 4 wiring unknowns above.
2. **Live-verify** (route agent-turns to Overwatch/Windows; DOM-verify locally where possible):
   - Phase 1: "what can you do?" in a native + an ACP chat → real counts; "how do I connect a provider?" → correct steps + one offer. Cold-start panel renders translated (not raw keys); Settings toggle persists; panel dismiss persists.
   - Phase 2a: packaged build → diag subprocess spawns; `wayland_concierge_diag` returns redacted output with `available:true` for providers + scheduled tasks.
   - Phase 2b: ask Concierge "connect OpenAI" → card renders → paste key → Apply → provider actually connected; "set my default model to X" → applied; Cancel works; the card updates to accepted/cancelled.
3. **Land the fast-follows** (#9 diag persona-gating + SEC-1/SEC-2/NR-1; #10 residual coverage).
4. Re-run full green gate before declaring done.

## 4. Build discipline notes
- Swarm agents 529'd during this session (backend overload); 2b was built solo against the locked contract module (`conciergeConfig.ts`) — that contract is the source of truth if re-swarming.
- No AI signatures anywhere (project rule). Commits `<type>(<scope>): <subject>`. Push `ferrox`, gh `FerroxLabs` (drifts to TradeCanyon — re-`gh auth switch`).
