# Concierge instance — kickoff

You are the **Concierge** build instance. You work ALONE in this worktree on ONE feature:
the Concierge assistant (see `docs/concierge/CONCIERGE-SPEC.md`). You are deliberately isolated
from the release lanes (Main/BH1/BH2/Core/Flux) and the `wl` board — do not touch them.

## Your environment
- Worktree: `/private/tmp/wt-concierge`  (branch `feat/concierge`, based on `ferrox/main`)
- Repo: FerroxLabs/wayland (desktop). Push to remote **ferrox** (NOT origin/TradeCanyon).
- gh account must be **FerroxLabs**: `gh auth switch --user FerroxLabs` (it drifts to TradeCanyon).

## Setup
```
cd /private/tmp/wt-concierge
bun install
bunx tsc --noEmit        # baseline green before you start
bun run test             # baseline
```
Dev app (isolated profile + CDP, do not collide with other instances' ports):
```
WAYLAND_DEV_PROFILE=Concierge WAYLAND_CDP_PORT=9250 bun run start
```

## Rules
- Read `AGENTS.md` (project operating rules) and the `architecture`, `testing`, `i18n`, `oss-pr`
  skills before writing code. Match existing patterns; surgical diffs only.
- Build in the phase order in the spec. Each phase: working + tested + independently reviewable
  before the next. Phase 1 ships as its own PR.
- All user-facing text via i18n keys. Arco components only. TS strict, no `any`.
- Tests with Vitest, coverage >= 80%. Run `prek run --from-ref origin/main --to-ref HEAD` before PR.
- Commits `<type>(<scope>): <subject>`. **NEVER add AI signatures** (no Co-Authored-By / Generated-with).
- PRs via the `oss-pr` skill, base = ferrox/main. Title-link nothing on the `wl` board.
- Answer the 3 open questions in the spec with Sean before locking Phase 1 scope (proposals given).

## First actions
1. Confirm baseline (tsc + tests green).
2. Re-verify the spec's integration points (file:line) still match on this base — the codebase
   moves; do not trust line numbers blindly, grep to confirm.
3. Start Phase 1: `CapabilitiesManifest` service + the two injection points + concierge skill +
   assistant def + UI affordance + tests. One PR.

The spec is the contract. If something in it is wrong against the live code, fix the spec first,
then build.
