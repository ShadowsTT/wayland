# DOCS-DRIFT — Documentation drift audit

**Scope:** `/Users/seandonahoe/dev/wayland` superrepo + `app/` Electron source + `engine/` Rust source
**Branch audited:** `app/` on `feat/audit-hardening`; `engine/` on `main`
**Mode:** read-only — no edits applied, no commits
**Goal:** identify stale claims in user-facing docs before `v0.1.2-wayland-base` tag

## Summary

- Docs reviewed: 14 user-facing markdown files (excluding `.blackboard/`, `.worktrees/`, `.ijfw/`, `upstream/`, translated readme copies, and IJFW-managed `AGENTS.md` / `CLAUDE.md`)
- AUDIT_ONLY: 4 (`/AGENTS.md`, `/CLAUDE.md`, `app/AGENTS.md`, `app/CLAUDE.md` — IJFW-injected, not touched)
- CURRENT: 6 (`app/readme.md` modulo cosmetic Aion CLI mentions, `app/CONTRIBUTING.md`, `app/CONTRIBUTING.zh.md`, `app/docs/contributing/development.md`, `app/docs/SECURITY.md`, `app/docs/guides/wsl2-workaround.md`, `app/docs/architecture/overview.md`, `app/docs/README.md`)
- DRIFTED: 4 (`/README.md`, `app/THIRD-PARTY-NOTICES.md`, `engine/AGENTS.md`, `engine/README.md` minor)
- MISSING: 2 (`app/CHANGELOG.md`, no v0.1.2 release-notes doc)
- Drift count by severity: **P0: 2 · P1: 4 · P2: 4**

---

## /Users/seandonahoe/dev/wayland/README.md

**Status:** DRIFTED

**Drifts:**

### [P1] mise.toml pin claims do not match the actual file

- Doc: `/Users/seandonahoe/dev/wayland/README.md:29`
- Stale claim: `` `mise.toml` pins Node 25, Bun 1.3, Rust 1.94, just 1.51. ``
- Reality: `/Users/seandonahoe/dev/wayland/mise.toml` pins `node = "24"`, `bun = "1.3"`, `just = "1.51"`, and explicitly comments that Rust is **intentionally not pinned at workspace level** (system rustc is used; aionrs has its own `rust-toolchain.toml`).
- Suggested fix: change to "Node 24, Bun 1.3, just 1.51; Rust intentionally unpinned (see mise.toml comment)" — DO NOT apply.

### [P2] Node 25 in README also conflicts with `app/package.json` engines

- Doc: `/Users/seandonahoe/dev/wayland/README.md:29`
- Stale claim: implies Node 25 should be installed.
- Reality: `app/package.json` `engines.node` = `">=22 <25"` — Node 25 would be rejected by npm/bun engine check.
- Suggested fix: align README, mise.toml, and `engines.node`. Pick one source of truth (recommend `engines.node`).

---

## /Users/seandonahoe/dev/wayland/docs/REBRAND.md

**Status:** CURRENT (informational checklist; references are conditional like "if it exists")

No drift. The `app/NOTICE` file is mentioned conditionally — it does not exist, which the doc allows for. `app/THIRD-PARTY-NOTICES.md` is referenced as "new file" and exists.

---

## /Users/seandonahoe/dev/wayland/AGENTS.md  and  /Users/seandonahoe/dev/wayland/CLAUDE.md

**Status:** AUDIT_ONLY (IJFW-managed, do not modify)

**Notes (informational, not fixes):**

- Section 10 ("Project context") still contains `TODO` placeholders for Stack, Commands, Layout, Conventions, Forbidden — never filled in for this project. Worth knowing for the v0.1.2-base tag readiness checklist; but per task constraints, no action taken.
- Section 11 ("Project Learnings") is empty — same.
- Sections 1-9 are the boilerplate behavioral rules and are still valid.

---

## /Users/seandonahoe/dev/wayland/app/readme.md

**Status:** CURRENT (claims match implementation modulo intentional pre-rebrand naming)

**Drifts (cosmetic only):**

### [P2] Engine still referred to as "Aion CLI (aionrs)" in user-facing copy

- Doc: `app/readme.md:146`, `app/readme.md:167`, `app/readme.md:176`, `app/readme.md:194`
- Stale claim: e.g. `Aion CLI (aionrs, the Rust-based backend service bundled with Wayland)`
- Reality: Engine is now `wayland-core` (binary name confirmed at `app/scripts/prepareWaylandCore.js` + `engine/Cargo.toml` builds `wayland-core`). `WCORE_*` env vars are the canonical names; `AIONRS_*` are explicitly back-compat aliases per `engine/CHANGELOG.md` Unreleased section.
- Note: in-code agent directory is `src/process/agent/wcore/` (verified). The user-facing string can keep "Aion CLI" as the *product display name* (per HC-3 / display-strings decisions), but the implementation-level phrase "aionrs, the Rust-based backend" is now stale — engine is `wayland-core`.
- Suggested fix: replace "(aionrs)" with "(wayland-core)" or drop the parenthetical. Verify with display-strings owner before applying — this may have been deliberate per the brand-display rule.

### [P2] `bun run dev` referenced but script does not exist

- Doc: `app/readme.md:699`
- Stale claim: ``bun run dev        # start dev server``
- Reality: `app/package.json` has no `dev` script. Equivalent is `bun start` (which runs `electron-vite dev`). The same README/CONTRIBUTING elsewhere correctly uses `bun start`.
- Suggested fix: change `bun run dev` → `bun start` in the Development Setup section.

### [P2] `bun run test` is correct but README "Tech stack" line omits electron-vite/Bun pin context

- Doc: `app/readme.md:695`
- Stale claim: `Tech stack: Electron · Vite · React · Bun` (not strictly stale — just generic; bundled Bun pin + electron-vite specifics live in `docs/contributing/development.md` instead).
- Reality: accurate but high-level only. No fix needed unless tightening.

---

## /Users/seandonahoe/dev/wayland/app/CONTRIBUTING.md

**Status:** CURRENT

- All `bun run X` commands referenced (`format`, `lint`, `lint:fix`, `i18n:types`, plus `bunx tsc --noEmit`, `bunx vitest run`, `node scripts/check-i18n.js`) **exist** in `app/package.json` scripts or as direct invocations. Verified.
- L37 (W4-VERIFICATIONS.md AUDIT-03 F24) flagged "no CONTRIBUTING.md at app root" — that gap is now closed (file exists). But the lockfile/`packageManager`/`engines.bun` reproducibility contract recommended by F24 is **still not declared** anywhere in CONTRIBUTING.md.
- This is a gap to log but not a stale claim; logged under "Missing docs" below.

---

## /Users/seandonahoe/dev/wayland/app/CONTRIBUTING.zh.md

**Status:** CURRENT — mirrors English version 1:1, same script set, same i18n paths.

---

## /Users/seandonahoe/dev/wayland/app/docs/README.md

**Status:** CURRENT — every subdirectory referenced (`guides/`, `contributing/`, `architecture/`, `specs/`, `prds/`, `readme/`) exists.

---

## /Users/seandonahoe/dev/wayland/app/docs/SECURITY.md

**Status:** CURRENT

- Claim: `.deb` GPG verification deferred to v0.1.3+ release-infra chain — matches reality (no GPG verification hook in `app/src/process/services/autoUpdaterService.ts`, file exists, verified).
- Note: doc is 5 lines total. Sufficient for v0.1.2-safety scope; but bare-minimum coverage. A v0.1.2-base tag should consider whether this is the security policy doc that needs SEC reporting contacts, supply-chain stance, vuln disclosure flow. Flagged under "doc tasks for v0.1.2-base" below — not a drift.

---

## /Users/seandonahoe/dev/wayland/app/docs/guides/wsl2-workaround.md

**Status:** CURRENT

- Workaround instructions match: `--webui --no-sandbox` + mock `xdg-settings`. WebUI server boots independently of Electron sandbox path (verified via `app/src/server.ts`).
- Bundled-bun AVX claim is consistent with the existing `app/scripts/bundled-bun-shasums.json` pin (no AVX-free build is shipped in v0.1.2-safety, matches doc).
- Status text "v0.1.3 platform-fixes chain" is forward-looking, not a stale claim.

---

## /Users/seandonahoe/dev/wayland/app/docs/contributing/development.md

**Status:** CURRENT

- Cross-referenced every `bun run X` against `package.json` — **all listed scripts exist**. Verified: `start`, `start:multi`, `cli`, `webui`, `webui:remote`, `webui:prod`, `webui:prod:remote`, `resetpass`, `package`, `make`, `dist`, `dist:mac`, `dist:win`, `dist:linux`, `build-mac`, `build-mac:arm64`, `build-mac:x64`, `build-win`, `build-win:arm64`, `build-win:x64`, `build-deb`, `build`, `build:renderer:web`, `build:server`, `server:start`, `server:start:remote`, `server:start:prod`, `server:start:prod:remote`, `server:resetpass`, `server:resetpass:prod`, `lint`, `lint:fix`, `format`, `format:check`, `i18n:types`, `test`, `test:watch`, `test:coverage`, `test:contract`, `test:integration`, `test:bun`, `test:e2e`, `test:packaged:i18n`, `test:packaged:bun`, `debug:perf`, `debug:perf:report`, `debug:mcp`, `debug:mcp:list`, `debug:mcp:validate`, `debug:custom-agent`. 0 orphans.
- Env vars `WAYLAND_MULTI_INSTANCE` and `ALLOW_REMOTE` verified to be read by `src/common/config/appEnv.ts`, `src/index.ts`, and `src/server.ts`.

---

## /Users/seandonahoe/dev/wayland/app/docs/architecture/overview.md

**Status:** CURRENT

- Process model claim (`src/process/`, `src/renderer/`, `src/process/worker/`) verified — all dirs exist.

---

## /Users/seandonahoe/dev/wayland/app/THIRD-PARTY-NOTICES.md

**Status:** DRIFTED

### [P0] References to nonexistent integration paths

- Doc: `app/THIRD-PARTY-NOTICES.md:28` (the `## aionrs` attribution block)
- Stale claim: `Source code under \`src/process/agent/aionrs/\`, \`scripts/prepareAionrs.js\`, and related integration points references \`aionrs\` as a third-party package`
- Reality:
  - `app/src/process/agent/aionrs/` **does not exist**. Real directory: `app/src/process/agent/wcore/`.
  - `app/scripts/prepareAionrs.js` **does not exist**. Real script: `app/scripts/prepareWaylandCore.js` (verified — header comment confirms it prepares the `wayland-core` binary).
- Suggested fix: update integration-path list to `src/process/agent/wcore/` and `scripts/prepareWaylandCore.js`. Optionally add a sentence clarifying that `aionrs` was the upstream name and the local rebrand is `wayland-core` (this preserves the Apache-2.0 attribution chain). DO NOT apply — Apache-2.0 attribution language should be reviewed by a human before touching.

### [P1] "unmodified upstream" claim is now false

- Doc: `app/THIRD-PARTY-NOTICES.md:27`
- Stale claim: `Wayland integrates \`aionrs\` as an external, unmodified upstream dependency.`
- Reality: Per `engine/CHANGELOG.md` Unreleased entry, the Rust source has been rebranded to `wayland-core` — 11 crates renamed, binary name changed, config dirs changed (`~/.aionrs` → `~/.wcore`). This is no longer an unmodified mirror; it is a TradeCanyon-owned fork at `~/dev/wayland/engine` (the `TradeCanyon/wayland-core` GitHub repo). Apache-2.0 attribution still applies, but the wording "unmodified" is now incorrect.
- Suggested fix: rephrase to `Wayland integrates wayland-core (a TradeCanyon fork of iOfficeAI/aionrs) as a bundled runtime. The fork preserves Apache-2.0 copyright headers and attributions throughout.`

---

## /Users/seandonahoe/dev/wayland/engine/README.md

**Status:** CURRENT (modulo one minor item)

### [P2] Lists Anthropic, OpenAI, Bedrock, Vertex AI as providers

- Verified against `engine/crates/wcore-providers/` (implicit — Cargo workspace ships these four).
- Architecture diagram, docs links, and CLI examples all consistent with binary name `wayland-core`. Quick Start uses `wayland-core --init-config` — matches.

No P0/P1 drift in `engine/README.md`.

---

## /Users/seandonahoe/dev/wayland/engine/AGENTS.md

**Status:** DRIFTED (minor — internal contributor doc)

### [P2] "Electron-based AionUI" wording in engine AGENTS.md

- Doc: `engine/AGENTS.md:11`, `engine/AGENTS.md:207`
- Stale claim: `JSON stream protocol for host integration (e.g. Electron-based AionUI).` and again in the docs table.
- Reality: The host is now `Wayland` (the Electron app at `~/dev/wayland/app`). AionUI is the *upstream* of that fork, not the runtime client of the engine's JSON stream protocol.
- Suggested fix: replace `AionUI` → `Wayland (Electron app)` or `Wayland Desktop` in both occurrences. Engine AGENTS.md is a contributor doc, not user-facing, so P2.

---

## /Users/seandonahoe/dev/wayland/engine/CHANGELOG.md

**Status:** CURRENT

- Unreleased section captures the `aionrs` → `wayland-core` rebrand explicitly, the new `WCORE_*` env var primary names, and the back-compat `AIONRS_*` aliases. Matches reality.
- Historical entries (0.1.21 → older) intentionally retain `iOfficeAI/aionrs` links — correct (Apache-2.0 attribution chain).

---

## /Users/seandonahoe/dev/wayland/engine/RELEASING.md

**Status:** CURRENT

- First line names the binary `wayland-core` and references `scripts/prepareWaylandCore.js` — both verified to exist. No drift.

---

## Missing docs (severity-tagged)

### [P0] No `app/CHANGELOG.md` tracking the 75 commits of audit hardening

- Reality: `app/` has no `CHANGELOG.md` (verified — `ls CHANGELOG*` returns no matches). 75+ commits on `feat/audit-hardening` are not summarized anywhere user-facing.
- Tag-readiness blocker: yes, for `v0.1.2-wayland-base`. Consumers cannot understand what changed between `v0.1.1-wayland-base` and `v0.1.2-wayland-base` without reading 75 commit messages.
- Suggested action: generate `app/CHANGELOG.md` (or `app/CHANGELOG-AUDIT.md` if the conventional changelog will be auto-managed by `release-please` later) summarizing the audit-hardening waves (W1 IPC/CSP/Electron upgrade, W2 H1–H17 fixes, W3 deps, W4 localization+a11y, F audit follow-ups). Engine has one (`engine/CHANGELOG.md`); app should too. Do not apply during this audit.

### [P1] No reproducibility-contract section in `app/CONTRIBUTING.md`

- Per `.blackboard/W4-VERIFICATIONS.md` L37 (AUDIT-03 F24): `package.json` lacks `packageManager` field and `engines.bun` range; CONTRIBUTING.md does not state that `bun.lock` is authoritative.
- Status (this audit): CONTRIBUTING.md now exists (the L37 absence is closed), but the reproducibility contract is not documented inside it. F24 explicitly recommends three statements: (1) `bun.lock` authoritative, (2) `packageManager` or `engines.bun` pin, (3) CI rejects package changes without lockfile diff.
- Suggested action: add a "Reproducibility" section to `app/CONTRIBUTING.md` listing the three statements. Bonus: add `packageManager` or `engines.bun` field to `app/package.json` to mechanize the contract. Not in scope for this audit.

### [P1] No vulnerability disclosure / SECURITY contact in `app/docs/SECURITY.md`

- Doc covers only auto-update integrity (`v0.1.3+` deferred). It does not state a vuln-disclosure email, GitHub Security Advisories policy, or response SLA. Industry-standard `SECURITY.md` includes these.
- Suggested action (post-base, optional): expand `docs/SECURITY.md` or move it to `app/SECURITY.md` (root) to match GitHub Security tab convention.

### [P2] License headers on new docs (F audit's "11 new files")

- Spot-checked `app/docs/SECURITY.md`, `app/docs/guides/wsl2-workaround.md`, `app/CONTRIBUTING.md`, `app/CONTRIBUTING.zh.md`, `app/THIRD-PARTY-NOTICES.md` — none carry a per-file Apache-2.0 header.
- Reality: surrounding docs in the same directory (`docs/contributing/development.md`, `docs/contributing/file-structure.md`, `docs/architecture/overview.md`, the translated readme copies) also do not carry per-file Apache-2.0 headers. This matches AionUi upstream convention — markdown docs are covered by the repo-root `LICENSE` and per-file headers were never applied.
- Verdict: new docs are **consistent with existing convention**. No drift / no fix.

---

## Doc tasks for `v0.1.2-wayland-base` tag readiness

Recommended order (no work applied during this read-only audit):

1. **[P0]** Write `app/CHANGELOG.md` summarizing W1–W4 + F audit. Without this the tag is opaque to anyone outside the orchestrator session.
2. **[P0]** Fix `app/THIRD-PARTY-NOTICES.md` paths (`src/process/agent/aionrs/` → `src/process/agent/wcore/`; `scripts/prepareAionrs.js` → `scripts/prepareWaylandCore.js`) and rephrase the "unmodified upstream" sentence. Apache-2.0 attribution language change — review before applying.
3. **[P1]** Fix `/README.md` line 29 mise.toml claim (Node 25→24; Rust pin assertion is false; align with `engines.node`).
4. **[P1]** Decide on the `app/readme.md` "Aion CLI (aionrs)" wording — keep as display name or update to `wayland-core`. If keeping, add a one-liner README footnote so the implementation/display split is documented.
5. **[P1]** Add reproducibility contract section to `app/CONTRIBUTING.md` (closes W4 L37 F24).
6. **[P2]** Engine AGENTS.md: `AionUI` → `Wayland` in two places.
7. **[P2]** `app/readme.md`: `bun run dev` → `bun start` in Development Setup.
8. **[P2]** Consider expanding `app/docs/SECURITY.md` with vuln-disclosure contact (or defer to v0.1.3 release-infra chain as already implied).

## Verification methodology summary

- Every `bun run X` in `app/docs/contributing/development.md` cross-referenced against `app/package.json` scripts — 0 orphans, 0 missing.
- Every `bun run X` in `app/CONTRIBUTING.md` cross-referenced against `app/package.json` scripts — 0 orphans.
- File paths quoted in `app/THIRD-PARTY-NOTICES.md` checked against actual repo layout — 2 missing.
- Env vars `WAYLAND_MULTI_INSTANCE`, `ALLOW_REMOTE`, `NODE_ENV`, `ACP_PERF`, `PERF_MONITOR` checked against `src/` — all present.
- Versions: README mise claim vs `mise.toml` vs `package.json engines.node` — three-way mismatch on Node and Rust.
- Engine README binary/script names cross-referenced against engine `Cargo.toml` workspace targets and `app/scripts/prepareWaylandCore.js` — consistent.
- AGENTS.md / CLAUDE.md content reviewed (audit only, not modified).
- `.blackboard/W4-VERIFICATIONS.md` L37 cross-referenced — partial closure (CONTRIBUTING.md exists, reproducibility contract still absent).

## Constraints honored

- No docs were modified (especially not `AGENTS.md` or `CLAUDE.md`).
- No commits were created.
- Read-only audit; suggested fixes are written as one-line recommendations, never applied.
