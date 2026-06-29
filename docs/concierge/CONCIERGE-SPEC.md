# Concierge — Specification

**Status:** Draft for build. **Owner:** Concierge CLI instance (isolated worktree `feat/concierge`).
**Repo:** FerroxLabs/wayland (desktop). **Base:** ferrox/main @ 2f7de2bfd.

Concierge is a built-in assistant persona that knows Wayland inside-out and can eventually
operate it on the user's behalf. Built in two phases: Phase 1 gives it self-knowledge (it can
answer "what can Wayland do / what do I have / how do I do X"); Phase 2 gives it hands
(diagnostics, then conversational configuration, then optional remote access).

North star: the everyman who never wanted to become a programmer. Friction is the enemy.
Concierge is the front door to everything Wayland already does but nobody can find.

---

## 0. Why this exists (the gap)

Wayland ships 2,105 skills, 70 bundled workflows, ~100 connectable providers, assistants, teams,
scheduled tasks, workflows, and MCP — and the assistant cannot accurately tell a user any of it,
because the model has no structured view of its own product. Ask "what can you do?" and it
guesses. Concierge closes that gap, then extends from "tell me" to "do it for me."

## 1. Prior art: how AionUI's "butler" works (what to copy, what to skip)

Verified by reading AionUI (frontend `iOfficeAI/AionUi`) + AionCore (backend assets) source.

The butler is **not** a special model, agent runtime, or bespoke UI. It is an ordinary built-in
assistant defined by declarative assets:
- a persona/routing **system-prompt** (markdown), plus
- three **skills** (Claude-style SKILL.md + bundled scripts) that document and drive a
  pre-existing local control API.

Its three capability domains, each backed by one skill:
1. **Conversational configuration (write)** — create/edit assistants, import skills, add MCP
   servers, add providers + keys, set default model, change app settings. Implemented by a script
   that discovers a dynamic localhost port and hits `http://127.0.0.1:<port>/api/*`.
2. **Diagnostics (read-only)** — a script reading REST + SQLite + logs into a one-shot `overview`:
   provider/model health, why a cron didn't run, "MCP enabled but 0 tools", hung team members.
3. **Remote access** — a runbook that installs `cloudflared` and opens a quick tunnel to the local
   WebUI.

**Copy:** the *pattern* — persona + routing × skills that document a config/diag surface the agent
can call. **Skip / improve:** AionUI's security is weak — unauthenticated loopback control plane,
`GET /api/providers` returns API keys in **plaintext**, guardrails are prompt-level only. The
remote-access piece is a demo gimmick (ephemeral URL, single shared password, traffic via
Cloudflare). We do diagnostics + config with real consent + secret hygiene, and treat remote as
optional/deferred.

## 2. Wayland foundation (already exists — build on it)

Confirmed integration points (file:line on base 2f7de2bfd; reconfirm before editing):

- **Skills index** — `src/process/services/skills/SkillLibrary.ts` (singleton `getInstance()`;
  `load()`, `list(filter?)`, `get(name)`, `stats(filter?)`). Index has ~2,105 entries of type
  `skill | workflow | agent-profile` across ~39 categories. Bundled workflows loaded via
  `loadBundledWorkflows()` (70 entries).
- **Model/provider catalog** — `src/process/providers/ipc/modelRegistryIpc.ts`: `curatedForAgent({ agentKey })`
  returns curated models per agent; `getProviderCatalog()` (~100 providers).
- **System-prompt assembly (native Wayland Core)** — `src/process/task/agentUtils.ts`
  `buildSystemInstructionsWithSkillsIndex(config)` (currently injects Constitution + skills index
  + team guide + workflow protocol). This is the native injection point.
- **System-prompt assembly (ACP agents: Claude Code / Codex / etc.)** —
  `src/process/task/agentUtils.ts` `prepareFirstMessageWithSkillsIndex(content, config)`
  (injects the same into the first message as a `[Assistant Rules ...]` block, deliberately
  NOT XML-tagged so external CLIs honor it). This is the ACP injection point — REQUIRED so
  Concierge self-knowledge works when the user is driving Claude Code or Codex.
- **Per-turn skill retrieval (BM25)** — `agentUtils.ts` `buildTurnSkillContext(userText)` already
  ranks + auto-loads relevant skills per turn. Concierge how-to content rides this.
- **Constitution / persona overlay** — `src/process/services/constitution/composePrompt.ts`
  (supports per-assistant overlays via `assistantId`).
- **Assistant surface (home)** — `src/renderer/pages/guid/GuidPage.tsx` +
  `hooks/useGuidModelSelection.ts` + `components/GuidModelSelector.tsx`.
- **Built-in MCP server pattern** — `src/process/resources/builtinMcp/searchSkillsServer.ts`
  (precedent for exposing Wayland capabilities to any backend agent as MCP tools — the Phase 2
  delivery mechanism).
- **Confirmation / approval system** — reuse the existing tool-confirmation flow for all Phase 2
  mutations (do NOT invent a new consent path).

## 3. Naming & persona

Name is **Concierge** everywhere (user-facing label, assistant id `concierge`, skill ids
`concierge-*`). Premium, on-brand with "one system to rule them all", and deliberately NOT
"butler" (AionUI's term; also implies the heavy config/remote scope we gate carefully). Same
persona across both phases — Phase 1 gives it knowledge, Phase 2 gives it hands.

---

## PHASE 1 — Self-knowledge ("What can Wayland do? How do I do X?")

**Goal:** Concierge (and, when enabled, the default assistant) answers capability and how-to
questions accurately, grounded in live product data, in native chats AND through ACP agents.

### 1.1 Capabilities manifest service (new)
`src/process/services/capabilities/CapabilitiesManifest.ts`
- `buildCapabilitiesManifest(opts): Promise<string>` — compiles a COMPACT, accurate summary from
  live sources at call time (never a static blurb that drifts):
  - skills: total count + top categories (from `SkillLibrary.stats()` / `list()`),
  - workflows: count + names (bundled-workflows),
  - models/providers: connected providers + a few representative models (`curatedForAgent`),
  - headline features: assistants, teams, scheduled tasks, workflows, MCP, projects.
- Output is a short, token-bounded block (target a few hundred tokens, NOT the full index).
- `opts`: `{ includeSkills?, includeWorkflows?, includeModels?, agentKey? }`.
- Cache with cheap invalidation (skills index already lazy-loaded; recompute when catalog changes).

### 1.2 Injection (both backends)
- Add an optional `capabilitiesManifest?: string` to the first-message config and inject it in
  BOTH `buildSystemInstructionsWithSkillsIndex` (native) and
  `prepareFirstMessageWithSkillsIndex` (ACP) in `agentUtils.ts`, after the skills index and
  before the workflow protocol.
- Gate: ON for the Concierge assistant always; for other assistants, behind a setting (default
  decision is Sean's — propose default ON for the home assistant, OFF inside user assistants to
  avoid token cost).

### 1.3 Concierge how-to skill (new)
A single `concierge` SKILL.md (+ assets if needed) documenting Wayland's own features and concrete
"how do I…" answers (connect a provider, create an assistant, build/launch a workflow, set up a
team, schedule a task, connect an MCP server, switch models / use Flux Auto). Authored so the
existing BM25 retrieval surfaces it on intent. Lives in the bundled skills set.

### 1.4 Concierge assistant definition (new)
Register a built-in `concierge` assistant (persona system-prompt + routing) using the existing
built-in-assistant mechanism. Persona: warm, plain-English, zero jargon, leads with the answer,
offers the next concrete step. Routing (Phase 1): capability/how-to questions → answer from
manifest + concierge skill.

### 1.5 UI surface
- A "What can I do?" affordance on `GuidPage` + 3–5 starter prompts.
- A Concierge entry in the assistant list (uses existing assistant rendering — no bespoke UI).

### 1.6 Phase 1 non-goals
- No settings mutation, no diagnostics tooling, no remote access.
- No new model/agent runtime — Concierge runs on the normal engine path.
- Do not dump the full skills index into context — summary only.

### 1.7 Phase 1 acceptance
- In a native Wayland Core chat AND in a Claude Code/Codex ACP chat, "what can you do?" returns an
  accurate summary (real skill/workflow counts, real connected providers), and "how do I connect
  Claude / schedule a task?" returns correct steps.
- No measurable regression in turn latency; manifest stays token-bounded.
- Unit tests: manifest builder (shape, counts, token bound), injection presence at both points,
  concierge-skill retrieval on representative queries.

---

## PHASE 2 — The full Concierge (diagnostics → config → optional remote)

Delivered as **guarded Wayland MCP tools** (same pattern as `searchSkillsServer`) so ANY backend
agent can call them. Security-first is the differentiator vs AionUI. Build in sub-phases; each is
independently shippable.

### 2a — Diagnostics (read-only) — DO FIRST
New built-in MCP server `concierge-diag` (or extend builtin MCP) exposing read-only tools:
- provider/model health, connection status,
- "why didn't my scheduled task run" (read scheduler state),
- "MCP connected but 0 tools" inspection,
- recent errors / relevant logs (redacted).
Rules: **read-only**, **secrets never returned** (redact to last-4), bounded output.
Highest value, lowest risk — AionUI's most differentiated capability done safely.

### 2b — Conversational configuration (mutating) — NEEDS GATING
New built-in MCP server `concierge-config` exposing mutating tools:
- add a provider + API key, set default model,
- create/edit an assistant,
- add/configure an MCP server.
Security requirements (HARD):
- Every mutation routes through the EXISTING tool-confirmation/approval flow — explicit user yes,
  never silent. No new bypass path.
- Never echo secrets in plaintext anywhere (input or output); store via the existing secret store.
- Loopback/IPC control path must be authenticated (token), not open like AionUI's.
- Destructive/overwrite actions require an explicit confirm with a diff/summary of the change.

### 2c — Remote access (optional) — DEFER unless Sean greenlights
Only behind an explicit user-flipped toggle; honest caveats. Likely skip for v1 (gimmick-tier).

### 2.x Phase 2 acceptance
- Diagnostics tools return correct, redacted state and never mutate.
- Config tools cannot mutate without an explicit user confirmation; no secret is ever returned in
  plaintext; tampering/replay on the control path is rejected.
- Works from a native chat and from an ACP agent.

---

## 4. Conventions (this repo — non-negotiable)
- Three process types, never mix APIs: `src/process/` (main, no DOM), `src/renderer/` (no Node),
  `src/process/worker/`. Cross-process via IPC bridge (`src/preload.ts`).
- UI: `@arco-design/web-react` only (no raw interactive HTML); icons `@icon-park/react`;
  UnoCSS utilities + CSS Modules; semantic color tokens only.
- TS strict, no `any`; prefer `type`; path aliases `@process/* @renderer/* @worker/*`.
- All user-facing text via i18n keys (run `bun run i18n:types` + `node scripts/check-i18n.js`).
- Tests: Vitest, `bun run test`, coverage >= 80%. Directory <= 10 children; follow the
  `architecture` skill.
- Commits: `<type>(<scope>): <subject>`. **NEVER add AI signatures.** PRs via the `oss-pr` skill.

## 5. Out of scope (whole project)
- No changes to the release lanes, the `wl` board, or other instances' work. Concierge is
  isolated in this worktree until Sean decides to land it.
- No new model runtime. No telemetry beyond what exists.

## 6. Open questions for Sean (answer before/while building)
1. Default-ON manifest for the home assistant only, or all assistants? (proposal: home only)
2. Phase 2 order confirm: 2a diagnostics → 2b config → 2c remote (deferred)? (proposal: yes)
3. Ship Phase 1 as its own PR before starting Phase 2? (proposal: yes — independent value)

## 7. Build sequence
1. Phase 1: manifest service → injection (native + ACP) → concierge skill → assistant def → UI →
   tests. One PR.
2. Phase 2a diagnostics MCP → tests. One PR.
3. Phase 2b config MCP + consent/secret hardening → tests. One PR.
4. Phase 2c remote — only if greenlit.

Each phase must be working, tested, and independently reviewable before the next starts.
