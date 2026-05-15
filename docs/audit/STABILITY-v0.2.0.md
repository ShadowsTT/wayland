# v0.2.0-wayland-base Stability Audit

**Run:** 2026-05-15
**Commit:** 071c410 (`Merge W8c.3: wayland-ijfw plugin + capability flips + integration docs`)
**Tag:** `v0.2.0-wayland-base`
**Auditor:** Claude Opus 4.7 (read-only stability audit)
**Scope:** 22 workspace crates (16 internal + 4 plugins + workspace-hack + +eval shim)

## Summary

Engine is **stably built for the macOS/Linux happy path and currently green on CI for all three OSes**. The panic-free posture is excellent — every panic-equivalent macro outside `#[cfg(test)]` is structurally proven (let-else, exhaustive control flow, or build-script-only). Default-impl posture for security policies is **acceptable but uneven**: `CuaPolicy` defaults to opt-in approval; `BrowserPolicy` defaults to fail-open `Allow`; `BudgetConfig` defaults to unlimited (intentional, documented). The most material weaknesses are (1) the IJFW MCP server uses raw `Command::new("npx")` which breaks on Windows, (2) the `cargo-audit` step is `continue-on-error: true` so security advisories never gate a release, (3) the `eval-gate` justfile target is not invoked by any CI workflow despite being the locked acceptance gate for W10A, (4) `cargo hakari generate` has never been run on the empty `workspace-hack` crate, (5) workspace version is pinned at `0.1.21` while the release tag is `v0.2.0-wayland-base` — drift between human-readable tag and the version embedded in binaries, and (6) the new `wcore-browser`, `wcore-cua`, `wcore-eval`, `wcore-evolve` mid-tier crates are **not** in the `FORBIDDEN_CORE_IMPORTS` lint list, opening a regression vector for the plugin-api isolation boundary. No live correctness bugs. Several Wave-3 backends ship as "structural surfaces" with documented `W8c.x.B` follow-up work — not regressions, but stability of those features is not yet proven.

## Findings (severity-ordered)

### BLOCKER #1: IJFW MCP server breaks on Windows — `Command::new("npx")` bypasses platform shell
- **Location:** `crates/wcore-mcp/src/transport/stdio.rs:27` (the spawn site) and `crates/wayland-ijfw/src/mcp.rs:23-32` (the spec that triggers it).
- **Failure mode:** `wayland-ijfw` defaults to spawning the MCP server via `npx -y @ijfw/memory-server`. The stdio transport calls `tokio::process::Command::new("npx")` directly. On Windows, the actual binary is `npx.cmd`; raw `CreateProcess` ignores PATHEXT and refuses to resolve `.cmd` shims unless the caller uses `cmd /c` or appends the extension. AGENTS.md explicitly forbids this pattern: *"All shell invocations must go through `wcore_config::shell` module... Never call `Command::new("sh")`, `Command::new("bash")`, or `Command::new("cmd")` directly."* `wcore-mcp` violates that contract for the general case, and `wayland-ijfw`'s default config exposes it for every Windows user that loads the plugin.
- **Mitigation:** Route `transport/stdio.rs` through `wcore_config::shell::shell_command_builder()` so the command + args go through the same platform-aware launcher as Bash/Spawn tools. The fix is bounded to that one file; the spec layer doesn't need to change.

### BLOCKER #2: `cargo-audit` cannot fail CI
- **Location:** `.github/workflows/ci.yml:50-51` — `Security audit` step has `continue-on-error: true`.
- **Failure mode:** A new RUSTSEC advisory in any transitive dep (rustls, tokio, sqlx, etc.) flows through to a tagged release without anything stopping the merge. The audit log is emitted only as a soft signal that humans must read.
- **Mitigation:** Drop `continue-on-error`, and if false-positive triage is the reason, switch to `cargo deny check advisories` with a `deny.toml` that holds explicit ignores per RUSTSEC ID. (The workspace already pins `rustls-webpki = "0.103.13"` for RUSTSEC-2026-{0098,0099,0104} — proving the team is reading advisories; the gate should match.)

### MAJOR #3: `FORBIDDEN_CORE_IMPORTS` lint is stale w.r.t. Wave 3 crates
- **Location:** `crates/wcore-plugin-api/build.rs:8-22`.
- **Failure mode:** The lint blocks dependencies on `wcore-agent`, `wcore-tools`, `wcore-mcp`, `wcore-skills`, `wcore-memory`, `wcore-config`, `wcore-providers`, `wcore-compact`, plus dynamic-loading crates. Wave 3 introduced four new mid-tier crates — `wcore-browser`, `wcore-cua`, `wcore-eval`, `wcore-evolve` — none of which appear in the forbidden list. The plugin-api crate's isolation invariant ("must NOT depend on any wcore-* crate beyond wcore-types and wcore-protocol") is therefore unenforced for the new ones. A future drive-by `wcore-cua = { workspace = true }` in `wcore-plugin-api/Cargo.toml` will silently invert the dependency graph and the lint will say nothing.
- **Mitigation:** Append `"wcore-browser", "wcore-cua", "wcore-eval", "wcore-evolve", "wcore-observability", "wcore-repomap"` to `FORBIDDEN_CORE_IMPORTS`. The lint already runs at build-time and has `cargo:rerun-if-changed=Cargo.toml` wired correctly (line 25), so the additions take effect on next `cargo build`.

### MAJOR #4: `eval-gate` not enforced by CI
- **Location:** `justfile:117` defines the recipe (`vx cargo nextest run -p wcore-eval --features acceptance-gate acceptance_gate_meets_precision_recall_threshold --no-fail-fast --run-ignored only`) but **no `.github/workflows/*.yml` references `eval-gate` or invokes `wcore-eval`'s acceptance-gate features**. The W10A `LOCKED PUBLIC SURFACE` (`crates/wcore-eval/src/lib.rs:16`) states *"Required to pass before F12 GEPA (W10B) can ship"* — but `wcore-evolve` (W10B) is already in the workspace and shipping. The gate that's supposed to prevent regressions on the GEPA evolution loop is a manual local-dev recipe.
- **Mitigation:** Add an `eval-gate` job to `ci.yml` that runs `vx just eval-gate` on Linux only (the harness is platform-neutral; one runner is sufficient). Mark it `needs: ci` so it gates merge.

### MAJOR #5: Workspace version drift — `0.1.21` in Cargo.toml vs `v0.2.0-wayland-base` git tag
- **Location:** `Cargo.toml:40` (`version = "0.1.21"`); `cargo metadata` confirms every workspace member ships `0.1.21`. The release tag is `v0.2.0-wayland-base`.
- **Failure mode:** `env!("CARGO_PKG_VERSION")` is embedded in protocol Ready events (`crates/wcore-agent/src/output/protocol_sink.rs:164`). Host integrations (AionUI/Wayland Desktop) see `0.1.21` as the engine version regardless of the tag. The release artifact name will also baseline off `0.1.21` unless overridden in `release.yml`. Capability gating in the host based on engine version becomes ambiguous.
- **Mitigation:** Either (a) treat `-wayland-base` tags as documentation-only and bump `workspace.package.version` to `0.2.0` before the next tag (cleaner — the tag and the embedded version match), or (b) script the release workflow to assert `tag prefix == workspace version`. Today neither is true.

### MAJOR #6: `BrowserPolicy::default()` is fail-open
- **Location:** `crates/wcore-browser/src/policy.rs:69-77`.
- **Failure mode:** `BrowserPolicy::default()` produces `{ default_action: PolicyAction::Allow, allowed_origins: [], denied_origins: [] }`. Any code path that instantiates a policy without explicitly configuring it (config missing the `[browser.policy]` block, a test fixture that needs *any* policy, a plugin re-export that forgets to override) will allow every URL. Compare `CuaPolicy::default()` which defaults to `first_time_per_app_approval = true` — i.e. first-touch suspension — and which exposes a `permissive()` constructor as the explicit fail-open path. Browser policy has the inverse posture.
- **Mitigation:** Flip `BrowserPolicy::default()` to `default_action: PolicyAction::Deny` (matching the principle of least authority) and document `BrowserPolicy::permissive()` as the explicit-allow constructor. Tests that exercise the allow path can construct the permissive policy directly.

### MAJOR #7: `workspace-hack` is empty — declared but unmanaged
- **Location:** `workspace-hack/Cargo.toml`. Comment reads *"Hakari-managed dependency list will be placed here after first `cargo hakari generate`"*; `[dependencies]` is empty.
- **Failure mode:** `cargo hakari generate` has never been run. The `hakari-verify` recipe (justfile:80) and the `check-all` chain (justfile:112) will pass trivially against an empty hack crate. Every workspace member still depends on `workspace-hack` (line 36 of root `Cargo.toml`), and the dependency does nothing. Build-cache fragmentation for large workspaces is the documented reason to use hakari — declaring it but not populating it pays the indirection cost without the benefit, and creates a false signal that build dedup is being maintained.
- **Mitigation:** Either run `cargo hakari generate` and commit the populated dep list (then make `hakari-verify` actually verify), or remove the empty `workspace-hack` member + the `wcore-cli` reference until hakari is genuinely in use.

### MINOR #8: No `[profile.release]` configuration
- **Location:** Root `Cargo.toml`. No `[profile.release]`, no `[profile.dev]`, no `[profile]` section at all.
- **Failure mode:** Defaults are: `opt-level=3`, `lto=false`, `codegen-units=16`, `strip=false`, `debug=false`. For a CLI binary intended for distribution that means (a) larger-than-necessary binary because LTO is off, (b) codegen-units=16 leaves cross-fn-inline opportunities on the table, (c) `strip=false` keeps symbols (debugging is easier — but binary size on macOS is ~2-3x what it could be), (d) `debug=false` means **release binaries have no debug info**, so production-side crash reports won't symbolicate. AGENTS.md doesn't mandate LTO, so this is a posture call, but flagging because the H.6 binary-size measurement task (#113) is still pending and depends on this being decided first.
- **Mitigation:** Add a minimal profile aligned with the deployment story:
  ```toml
  [profile.release]
  lto = "thin"          # or "fat" if release-size is the only constraint
  codegen-units = 1     # better optimization at the cost of build time
  strip = "debuginfo"   # keep symbols stripped from binary, embedded debug elsewhere
  debug = 1             # line tables for crash report symbolication
  ```

### MINOR #9: No `rust-version` MSRV pin in any Cargo.toml
- **Location:** Root `Cargo.toml`; spot-checked `crates/*/Cargo.toml`.
- **Failure mode:** MSRV is governed entirely by `vx.toml` (`rust = "1.95.0"`). Anyone who builds without `vx` — most external contributors, anyone running `cargo build` directly — will get whatever toolchain is on PATH. If their toolchain is older than what the code requires (e.g. uses `let-else`, edition 2024 features, etc.), they get cryptic compile errors instead of a clean "this crate requires Rust 1.X+".
- **Mitigation:** Add `rust-version = "1.95"` to `[workspace.package]` and inherit it in each crate via `rust-version.workspace = true`. Cargo will then emit a friendly MSRV error.

### MINOR #10: Plugin runner silently swallows `ScopedRegistry` permission denials
- **Location:** `crates/wcore-agent/src/plugins/runner.rs:105-111`.
- **Failure mode:** Each `Scoped*Registry::new(manifest, ...)` returns `Err` either when (a) the plugin manifest doesn't declare the capability flag (expected, fine) OR (b) some other access-gate condition fails. The `.ok()` collapses both into `None`. If a real access bug ever sneaks into `PluginAccessGate`, the symptom is "this plugin's tools don't appear at runtime" — invisible failure. The block comment (line 99-102) explicitly acknowledges this design choice as expected behaviour.
- **Mitigation:** Distinguish "permission not requested" from other `PluginError` variants and log/propagate the non-permission cases. Cheapest fix: `match Scoped*Registry::new(...)`, route `PluginError::AccessDenied` to `None`, route other errors to the `errors: Vec<(String, PluginError)>` already collected on line 96.

### MINOR #11: `BudgetConfig::default()` is fully unlimited
- **Location:** `crates/wcore-config/src/budget.rs:23-32`. Every field is `Option<T>` defaulting to `None`. AGENTS.md crate-map labels this "ExecutionBudget caps... All fields default to `None` = no cap. Wired through bootstrap into `ExecutionBudgetView`."
- **Failure mode:** A user who never writes a `[budget]` block gets no wall-time, no tool-runtime, no process count, no tokens, no cost ceiling. For a CLI driving LLM APIs that's a financial-blast-radius default. Whether this is appropriate depends on whether the engine is intended for unattended autonomous operation (current trajectory: yes — W10B GEPA, evolution loop, autonomous wave executor).
- **Mitigation:** Either ship a conservative default (e.g. `max_cost_usd: Some(5.0)`, `max_wall_time_secs: Some(3600)`) or print a one-line warning on bootstrap when the budget is fully unlimited. The W8a A.5 design intentionally chose opt-in; this finding is "current default may be wrong as the engine matures into autonomous workloads."

### MINOR #12: `unreachable!()` in production retry loop survives only by careful reasoning
- **Location:** `crates/wcore-providers/src/retry.rs:24`.
- **Failure mode:** The `for attempt in 0..=max_retries` loop's match has three arms: `Ok` returns, retryable `Err` continues (gated by `attempt < max_retries`), other `Err` returns. When `attempt == max_retries` and the err is retryable, the second arm's guard fails and falls through to the third arm — which returns. So `unreachable!()` is genuinely unreachable. *However*, if a future refactor changes the guard to `attempt <= max_retries` or moves the early-return out of the third arm, the panic fires in production with an unhelpful "internal error: entered unreachable code" message and no context. Replace with `return Err(ProviderError::RetryExhausted)` or similar typed error so a refactor mistake surfaces as a normal error path.
- **Mitigation:** Change to a typed error return. The loop's max iterations is provably bounded, so the type-system fix is free.

### MINOR #13: `expect()` calls in plugin context registration assume host invariants
- **Location:**
  - `crates/wayland-ijfw/src/agents.rs:101` — `ctx.agents.as_mut().expect("manifest declares register_agents=true so the agent registry must be present")`.
  - `crates/wayland-ijfw/src/mcp.rs:41` — analogous for `ctx.mcp_servers`.
  - `crates/wayland-ijfw/src/skills.rs`, `tools.rs`, `hooks.rs`, `rules.rs` likely identical pattern (not all read individually but the comment chain references the same invariant).
- **Failure mode:** The invariant is "host populates `ctx.<surface>` when manifest declares the capability flag." `plugins/runner.rs:105-111` does in fact populate when the access gate allows it. So the invariant holds *for this host*. A third-party host that re-implements `PluginContext` differently (or a future refactor that changes the surface-population logic) breaks every plugin at startup with a panic instead of a typed error.
- **Mitigation:** Return `PluginError::HostMisconfiguration { surface: "agents" }` instead of panicking. Plugin loading already collects errors into the InitializeOutcome (line 133 of runner.rs), so this routes cleanly into existing error handling.

### MINOR #14: Wave-3 backends are "structural surfaces" with no live impl
- **Location:**
  - `crates/wcore-cua/src/backends/macos.rs` — "Real CGEvent + Core Graphics calls land in W8c.2.B" (#109).
  - `crates/wcore-cua/src/backends/windows.rs` — "Real `SendInput` + `UIAutomation` calls land in W8c.2.B."
  - `crates/wcore-cua/src/backends/linux_x11.rs` — "Real xdotool/scrot shell-outs land in W8c.2.B."
  - `crates/wcore-browser/src/backends/` — `chromiumoxide` / `browserbase` backends pending (#105).
- **Failure mode:** Not a bug today — the test suite exercises the structural surface (TT, screenshot synth, frontmost probe). But stability of these features in production is **unverified by anything in the current CI** because the actual platform calls don't exist yet. The risk is that the structural-shape contract differs from what the real impl needs (e.g. cancel-token semantics, redaction integration, error propagation through `CuaError` variants), and the real-impl PR has to redesign the surface — silently breaking the "LOCKED PUBLIC SURFACE" promise that consumers rely on.
- **Mitigation:** Already tracked as pending tasks #105/#109/#113. Just keep them flagged as "not stability-tested" until they land — don't let the `v0.2.0-wayland-base` framing imply CUA + Browser are production-quality.

### MINOR #15: Bedrock-region/Vertex-region defaults not gated to `Option`
- Spot-checked `crates/wcore-config/src/config.rs` for Bedrock/Vertex Defaults — these are wrapped in `Option<BedrockConfig> / Option<VertexConfig>` (line 126-127), so they don't claim a default region. Good — no finding here, just verifying.

### NOTE #16: `inventory::submit!` linkage looks correct
- All four plugins (`wayland-ollama`, `wayland-browser`, `wayland-cua`, `wayland-ijfw`) submit at module scope (not function scope), and all four are linked into `wcore-cli/Cargo.toml:32-35` as workspace deps. The `inventory_discovery.rs` integration test (`crates/wcore-plugin-api/tests/inventory_discovery.rs`) exercises the round-trip. The `wayland-ollama/tests/plugin_load_test.rs:49` asserts exactly-once submission, which guards the dead-code-elimination concern raised in the audit prompt. No finding — this is working as designed.

### NOTE #17: Tests using `Path::new("/tmp/...")` are correctly gated
- `crates/wcore-memory/src/paths.rs:366,382` (the `validate_memory_path` test) is gated with `#[cfg(unix)]` and has a `#[cfg(windows)]` counterpart at line 374. Other `/tmp/` usage in `file_history.rs`, `plan/file.rs`, `file_write_notifier.rs` is string-only (no FS touch). No Windows-CI flakes attributable to these.

### NOTE #18: `let _ =` writeln! patterns are safe
- `crates/wcore-skills/src/audit.rs:129-151` discards `writeln!` into a `&mut String` — that target type cannot fail, so the discard is semantically a no-op. Not a finding.

## Coverage gaps

What this audit did **not** probe (would need a longer pass):

- **Concurrency invariants.** No race-condition / deadlock analysis on `Arc<Mutex<...>>` / `parking_lot::Mutex` usage in CUA backend `cached_frontmost`, in `wcore-skills/watcher` (signal_rx / version_tx), or in the `wcore-eval` corpus loader.
- **Unsafe / FFI surface.** Did not grep for `unsafe { ... }`. `aws-sdk-sts`, `rusqlite` (bundled), `windows-rs`, `image` (PNG decoding) all have unsafe transitively — no audit of unsafe boundaries in our own code.
- **`wcore-mcp` JSON-RPC framing.** The transport layer talks to arbitrary child processes; malformed-frame handling and unbounded-length reads were not inspected.
- **Provider streaming back-pressure.** `tx.send(...).await` patterns with `let _ =` in `wcore-providers/{openai,anthropic_shared,vertex,bedrock}` silently drop on receiver-gone. Drop semantics are correct here, but I didn't verify that all streaming paths drain before `Done` — a leak in the unfinished-buffer drain would manifest as truncated final messages.
- **Hook engine recursion guards.** `crate::hooks::HookOutcome` and `run_pre_tool_use` are used inside the orchestration loop; whether a hook can recursively trigger a hook (and whether the engine has a depth guard) was not checked.
- **Memory crate path traversal.** Spot-checked `validate_memory_path` for the `/tmp/../../etc/passwd` case (test passes) but did not enumerate the full attack surface against `wcore-memory`'s public API.
- **Plugin manifest schema evolution.** `PluginManifest` has `register_*` boolean flags — what happens when a future flag is added and an older host loads a newer plugin? No backward-compat / forward-compat protocol-version analysis.
- **Cross-platform release build.** Did not actually run `cargo build --release --target x86_64-pc-windows-msvc` etc. — relied on CI matrix in `.github/workflows/ci.yml` (which does run those builds, and per the most recent commit on `main` they pass).
- **eval-gate threshold drift.** The audit found that `eval-gate` is not in CI; did not verify whether the LOCKED precision/recall constants in `wcore-eval` have been modified since W10A landing.

## Severity counts

- **BLOCKER:** 2 (#1 Windows MCP, #2 cargo-audit non-blocking)
- **MAJOR:** 5 (#3 lint coverage, #4 eval-gate not in CI, #5 version drift, #6 BrowserPolicy default-open, #7 hakari unused)
- **MINOR:** 8 (#8 no release profile, #9 no MSRV, #10 scoped-registry error swallow, #11 unlimited budget default, #12 retry unreachable, #13 plugin context expects, #14 CUA/browser structural-only, #15 confirmed clean)
- **NOTE:** 3 (#16 inventory, #17 path gates, #18 writeln)

## Recommendation

The two BLOCKERs are bounded local fixes (one file each). The five MAJORs are mostly CI/policy decisions — none require code rewrites of the engine itself. Fixing #1, #2, #3, #4, #5 before the next tag would close the highest-leverage gaps without touching wave-3 code. #6 (BrowserPolicy) is the only finding that asks for a semantic behaviour change and should be discussed before flipping the default, since flipping it from Allow → Deny will break any existing config that relies on the implicit allow.
