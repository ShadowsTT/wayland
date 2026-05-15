# v0.2.0-wayland-base Validation Pass

**Run:** 2026-05-15
**Commit:** `071c410` (tagged `v0.2.0-wayland-base`)
**Validator:** read-only audit, no code edits, no commits.

## Summary

| Check | Verdict | Evidence |
|---|---|---|
| Release build | **PASS** | `vx cargo build --release --workspace` → exit 0, `Finished release profile [optimized]` |
| CLI launches | **PASS (with caveat)** | `target/release/wayland-core --help` prints usage; `--version` prints `wayland-core 0.1.21` (NOT 0.2.0 — see BLOCKER #2) |
| Plugin discovery observable from CLI | **NO — discovery is DEAD CODE in the shipped binary** | `nm` shows zero `wayland_browser/cua/ijfw/ollama` symbols; live `--json-stream` Ready event has no `browser_suite`/`computer_use`/`plugins` keys (see BLOCKER #1) |
| Wayland Desktop tolerance for new variants | **PARTIAL — silently drops, does not crash** | `app/src/process/agent/wcore/index.ts:217-350` is a closed `switch (event.type)` with no `default`; `app/src/process/agent/wcore/protocol.ts` `WCoreEvent` union has none of the W8c.* variants. Behavior: `JSON.parse` succeeds → switch falls through silently. No crash, no warning, no surfacing. |
| Protocol round-trip via existing infrastructure | **PASS (test-only)** | `crates/wcore-agent/tests/w7_pre0_test_driver.rs` drives engine + `ScriptedProvider` via `AgentBootstrap::build_for_test` and asserts on `captured_protocol_events()`. Used widely (capability_advertising_test, w9_1_skill_drafting_per_turn, …). Wire shape is JSON-Lines as observed live. |
| Ollama `--model ollama:*` routing | **DEAD CODE** | `crates/wcore-agent/src/plugins/adapters/provider_registrar.rs` only `push`es `Arc<dyn PluginProvider>` into a `Vec`. No downcast, no `LlmProvider` translation, no consumer. `wcore-cli/src/main.rs:267` resolves provider via `config.provider_label`; nothing reads `HostProviderRegistrar.registered`. The file's own doc comment admits: "downcast/translate ... is the W8c.3.D chain edge" — confirmed deferred (Task #113). |

Severity counts: **2 BLOCKER**, **3 MAJOR**, **2 MINOR**, **2 NOTE**.

---

## Findings (severity-ordered)

### BLOCKER #1: Plugin discovery does not happen at runtime — `inventory::submit!` symbols are stripped from the release binary

- **Location:** `crates/wcore-cli/Cargo.toml:32-35` (deps declared) vs. `crates/wcore-cli/src/main.rs` (no `use wayland_*`, no `extern crate wayland_*`).
- **What's wrong:** `wayland-browser`, `wayland-cua`, `wayland-ijfw`, `wayland-ollama` are listed as path dependencies of `wcore-cli` but **nothing in `wcore-cli/src/**` ever references any item from those crates**. The `cargo tree -p wcore-cli` output shows them as dependencies, but Rust's linker dead-code-strips entire crates whose items are never used. `inventory::submit!` works by emitting a static item with a link-section attribute — if the crate is stripped, the submission never reaches the inventory registry.
- **Evidence:**
  - `grep "wayland_\|extern crate" crates/wcore-cli/src/main.rs` → zero hits.
  - `nm target/release/wayland-core | grep -iE "wayland_(browser|cua|ijfw|ollama)"` → empty.
  - `strings target/release/wayland-core | grep -E "wayland-(browser|cua|ijfw|ollama)|WaylandBrowser|WaylandCua|WaylandIjfw|WaylandOllama"` → empty.
  - Live run: `echo "" | target/release/wayland-core --json-stream --provider anthropic --api-key fake` Ready event capability keys are exactly `["tool_approval","thinking","effort","effort_levels","modes","current_mode","mcp","cost_attribution"]` — none of `browser_suite`, `computer_use`, `plugins` are present even though `skip_serializing_if = "is_false"` would emit them once flipped to true. `PluginCapabilitySet::from_loaded(&[])` (empty `loaded_plugin_names`) produces all-false, consistent with `plugin_inventory::iter()` yielding zero factories.
- **Impact:** Every W8c.* deliverable (browser suite, CUA, IJFW anchor, Ollama provider) is non-functional in the shipped binary despite passing unit + integration tests. The W8c.3 H.2 capability-advertising tests pass because they construct `PluginCapabilitySet` from a literal `Vec<String>` — they do NOT exercise the inventory→loader→bootstrap chain end-to-end. `v0.2.0-wayland-base` ships a plugin system that is structurally complete but inert.
- **Fix:** Force-link the plugin crates from `wcore-cli`. The canonical pattern is a no-op reference per crate at the top of `main.rs` (or a `plugin_link.rs` module):
  ```rust
  // Force the linker to keep plugin static items so `inventory::submit!` works.
  use wayland_browser as _;
  use wayland_cua as _;
  use wayland_ijfw as _;
  use wayland_ollama as _;
  ```
  Verify post-fix with `nm target/release/wayland-core | grep wayland_browser` and a live Ready-event dump that includes `"browser_suite":true,"computer_use":true,"plugins":true`.

### BLOCKER #2: Version not bumped — `wayland-core --version` prints `0.1.21` under the `v0.2.0-wayland-base` tag

- **Location:** `Cargo.toml:40` workspace `version = "0.1.21"`. `crates/wcore-cli/Cargo.toml:4` inherits `version.workspace = true`. CLI `clap(version)` derives from `CARGO_PKG_VERSION`.
- **What's wrong:** The git tag is `v0.2.0-wayland-base` but the binary self-reports `wayland-core 0.1.21`. Also visible in the wire `Ready.version` field (`"version":"0.1.21"`).
- **Impact:** Hosts gating on engine version (e.g. Wayland Desktop's host decoder comment "wcore ≤0.1.21 omits this field") cannot distinguish v0.1.21 from v0.2.0. Telemetry, support, bug reports all see the wrong version. Release-engineering hygiene break.
- **Fix:** Bump `Cargo.toml:40` to `version = "0.2.0"` (or `0.2.0-base` if pre-release semver is desired). Rebuild. Confirm `wayland-core --version` and `Ready.version` both read `0.2.0`.

### MAJOR #3: Host decoder silently drops every new W8c.* event variant

- **Location:** `/Users/seandonahoe/dev/wayland/app/src/process/agent/wcore/protocol.ts` (closed `WCoreEvent` union) and `/Users/seandonahoe/dev/wayland/app/src/process/agent/wcore/index.ts:217-350` (`handleEvent` switch with no `default`).
- **What's wrong:** `WCoreEvent` enumerates only the v0.1.21 shape: `ready`, `stream_start`, `text_delta`, `thinking`, `tool_request`, `tool_running`, `tool_result`, `tool_cancelled`, `stream_end`, `error`, `info`, `config_changed`, `mcp_ready`, `pong`. None of `BrowserEvent`, `BrowserPolicyDenied`, `CuaEvent`, `CuaPolicyDenied`, `PluginEvent`, `EvolutionEvent`, `skill_drafted`, `tool_chunk`, `sub_agent_event`, `suspend`, `approval_required`, `approval_resume`, `compact_offload`, `trace_event`, `session_cost` exist in the union. `handleEvent` is `switch (event.type) { case ...: ... }` with no `default`. Parse path: `JSON.parse(line) as WCoreEvent` succeeds (TS cast is structural only at runtime), the switch falls through every case, no handler fires, no warning logged.
- **Impact:** TOLERANT (no crash) but **invisible**. The engine could be emitting browser/CUA/plugin/evolution telemetry and the host would render nothing — including diagnostics like `BrowserPolicyDenied` or `CuaPolicyDenied` which are explicitly user-safety signals. Combined with BLOCKER #1, this is currently a non-issue because the engine emits none of these variants either — but the moment BLOCKER #1 is fixed, the host's silence becomes the new bottleneck.
- **Fix:** Two-part. (a) Add a `default:` arm in `handleEvent` that logs at debug level (`console.debug('[wcore] unknown event:', event.type)`) — turns silent into traceable. (b) Extend `WCoreEvent` with the new variants the host should actually surface (`browser_event`, `browser_policy_denied`, `cua_event`, `cua_policy_denied`, `plugin_event`). Spec source: `crates/wcore-protocol/src/events.rs:224-301`.

### MAJOR #4: Ollama provider routing is unimplemented — `host_register_provider` is a write-only sink

- **Location:** `crates/wcore-agent/src/plugins/adapters/provider_registrar.rs:27-39`.
- **What's wrong:** `HostProviderRegistrar::host_register_provider` only `push`es `Arc<dyn PluginProvider>` onto `registered: Vec<Arc<dyn PluginProvider>>`. No code path consumes the vec. The CLI's model-resolution (`crates/wcore-cli/src/main.rs:267,566`) reads `config.provider_label` and routes through the static `wcore-providers` enum (Anthropic, OpenAI, Bedrock, Vertex). `--model ollama:*` has no special-case dispatch; it would be treated as a model name on whatever provider is configured.
- **Evidence:** The file's own doc comment (lines 4-7): *"The remaining piece — downcast/translate `Arc<dyn PluginProvider>` to a concrete `wcore_providers::LlmProvider` impl so the engine can route a turn through it via `--model ollama:*` — is the W8c.3.D chain edge."* Task #113 in the project task list confirms `W8c.3.D — B.4 Ollama wiremock smoke (post-v0.2.0)` is pending.
- **Impact:** Honest acknowledgement of deferred work in the source — not a regression vs. plan, but a known-incomplete chain edge. Combined with BLOCKER #1, the wayland-ollama plugin is doubly inert: it isn't linked, and even if it were, its provider wouldn't be reachable.
- **Fix:** Implement the downcast / translator in `provider_registrar.rs` (or a dedicated dispatcher), wire `wcore-cli` model resolution to consult the registrar when the model spec matches `<plugin-provider>:<model>`. Cover with `B.4` wiremock test per Task #113.

### MAJOR #5: No end-to-end CLI test verifies `inventory::submit!` populates `plugin_inventory::iter()` at runtime

- **Location:** `crates/wcore-agent/tests/capability_advertising_test.rs` (the W8c.3 H.2 test) calls `PluginCapabilitySet::from_loaded(&names)` with literal `Vec<String>` inputs. No test in `crates/*/tests/` boots the actual CLI binary and asserts the Ready event lists the loaded plugins. `crates/wayland-ollama/tests/plugin_load_test.rs` iterates `inventory::iter::<&'static dyn PluginFactory>` from *inside the wayland-ollama crate's own test binary*, so it's guaranteed to find its own submission — that test doesn't catch the wcore-cli linker stripping.
- **What's wrong:** Coverage gap. The chain `[plugin crate submitted] → [linker keeps it] → [PluginLoader::discover finds it] → [bootstrap names list populated] → [Capabilities flag emitted]` is asserted only piecewise. BLOCKER #1 slipped through this seam.
- **Impact:** Any future regression that breaks plugin linkage (e.g. dropping a `use plugin_name as _;` line) won't be caught by the existing test suite.
- **Fix:** Add `crates/wcore-cli/tests/plugin_discovery_e2e.rs` that spawns `target/debug/wayland-core --json-stream --provider anthropic --api-key fake`, sends one stdin newline, parses the first stdout line as JSON, and asserts `event.capabilities.plugins == true` and the expected per-plugin flags are present. Or alternately, a `cargo test --test ...` that calls `AgentBootstrap::build` (the real path, not `build_for_test`) and inspects the resulting `loaded_plugin_names`.

### MINOR #6: `HostProviderRegistrar` has zero unit-test coverage for duplicate detection

- **Location:** `crates/wcore-agent/src/plugins/adapters/provider_registrar.rs:28-38`.
- **What's wrong:** The duplicate-name guard (`if any p.provider_name() == provider.provider_name() return Err`) is untested. No `#[cfg(test)] mod tests` in the file; no integration test exercises the error path.
- **Impact:** Low — the function isn't reachable in the shipped binary (BLOCKER #1) — but once that's fixed, this guard becomes load-bearing.
- **Fix:** Add a 2-test module: one happy-path registration, one duplicate-name returning the expected error string.

### MINOR #7: `Capabilities` advertises new flags by serde omission, but the host decoder doesn't consume them

- **Location:** `crates/wcore-protocol/src/events.rs:373-396` (`browser_suite`, `computer_use`, `plugins`, `gepa_enabled` all `skip_serializing_if = "is_false"`); host `WCoreCapabilities` type (`app/src/process/agent/wcore/protocol.ts:30-37`) lists only `tool_approval`, `thinking`, `effort`, `effort_levels`, `modes`, `mcp`.
- **What's wrong:** The wire shape is forward-compatible (default-false, skipped when off — byte-identical to v0.1.21). But the host's `WCoreCapabilities` type has no fields for the new flags. Unknown fields in JSON are silently ignored by TS — same tolerance pattern as MAJOR #3 — so the host *cannot* gate UI on `caps.browser_suite` even when the engine starts setting it.
- **Impact:** No crash; capability-driven UI surfaces that depend on these flags will never light up until the host type is extended.
- **Fix:** Extend `WCoreCapabilities` with optional fields matching the engine struct: `browser_suite?: boolean; computer_use?: boolean; plugins?: boolean; gepa_enabled?: boolean; streaming_tools?: boolean; ...`.

### NOTE #8: Workspace tests not run in this validation pass (scope = "validation" not "full re-test")

- The release build succeeded clean; unit + integration test execution was explicitly out-of-scope per the run brief ("Read-only + commands + write the report"). The validation focused on shipped-binary observables, not re-running the test suite. Re-running `vx cargo nextest run --workspace` is the next obvious smoke if validation expands.

### NOTE #9: Binary size — 24,388,800 bytes (≈ 23.3 MiB) for the macOS arm64 release build

- `target/release/wayland-core` weighs 24.4 MB stripped of nothing. The deferred Task #113 `H.6 binary size measurement` is the formal home for tracking this; recording it here for the audit trail. For comparison: the binary contains zero plugin code (per BLOCKER #1), so a post-BLOCKER-#1 fix will increase size — useful baseline.

---

## Coverage gaps (what this pass did NOT probe)

- **Did not run `vx cargo test --workspace` / `vx just push`** — release build only. The CI test matrix is the canonical correctness signal; this pass deliberately scoped to "does the shipped binary actually do what v0.2.0 claims".
- **Did not exercise Wayland Desktop runtime** — read the decoder source only (per run brief: "Don't try to npm-install Wayland Desktop"). Cannot confirm behavior under real engine-emitted unknown variants because BLOCKER #1 means the engine doesn't emit them.
- **Did not probe `--login` / OAuth flows**, `--skills-promote`, `--skills-audit`, MCP server registration via stdin, or `set_mode` / `set_config` commands — they're orthogonal to the W8c.* deliverable being validated.
- **Did not run the `wayland-ollama` plugin's own `tests/plugin_load_test.rs`** — that test guarantees the plugin can find its own submission within its own test binary; it does not test the wcore-cli linkage path, so re-running it would not have caught BLOCKER #1.
- **Did not verify `wcore-evolve` GEPA round-trip** — W10B-era; out of v0.2.0 W8c.* scope.
- **Did not check Windows / Linux CI builds** — local dev is macOS arm64 only; cross-platform regressions covered by CI.

---

## Bottom line

`v0.2.0-wayland-base` builds cleanly and the CLI launches, but **the plugin system shipped in this tag is dead code in the released binary**. The W8c.3 H.2 capability-flip logic is correct in isolation (unit tests pass) but is never reached at runtime because `wcore-cli/src/main.rs` does not force-reference the plugin crates, so the linker strips them along with their `inventory::submit!` static items. Compounding this, the workspace version was not bumped from `0.1.21`, and the Wayland Desktop host decoder silently drops every new event variant. Two BLOCKERs, both mechanical to fix; one MAJOR host-side type gap; one MAJOR known-deferred Ollama routing edge (already tracked as Task #113).

Recommendation: cut `v0.2.0-wayland-base.1` (or treat `v0.2.0-wayland-base` as ship-blocked pending the linker fix) with: (a) `use wayland_* as _;` lines in `main.rs`, (b) workspace version bump to `0.2.0`, (c) the e2e plugin-discovery CLI test from MINOR #5 to prevent regression.
