# v0.2.0-wayland-base Reliability Audit

**Run:** 2026-05-15
**Commit:** 071c410 ("Merge W8c.3: wayland-ijfw plugin + capability flips + integration docs")
**Tag:** v0.2.0-wayland-base
**Mode:** Read-only static review

## Summary

The Wave-3 reliability scaffolding is more deliberate than typical pre-1.0 code:
`ExecutionBudget` uses `parking_lot::RwLock` + saturating arithmetic on integer
counters, every long-running tool that bothers to override `execute_with_ctx`
genuinely races `ctx.cancel.cancelled()`, and the `ResilientProvider` /
`CircuitBreaker` pair has explicit Closed → Open → HalfOpen state transitions
with tested fall-through.

The recurring failure pattern is **"cancel observed but underlying work not
actually aborted."** When a `tokio::select!` arm racing `ctx.cancel.cancelled()`
wins, the losing future is simply *dropped*. For futures that own a child
process (`Bash`) or an in-flight `reqwest` request (browser / MCP), drop does
not propagate to the OS-level resource — the subprocess keeps running, the HTTP
request keeps streaming. This is a real "looks-cancelled, isn't-cancelled"
gap, not a theoretical one.

Other notable gaps: `ChannelSink` and `SkillWatcher` external-event channel
use `unbounded_channel` (no backpressure → unbounded memory growth on slow
consumers); `ApprovalBridge` leaks `oneshot::Sender`s if the resolving side
crashes; the budget watcher in `cancel::budget_linked_with_callback` is a
self-documented task leak; and `PlateauDetector` silently never terminates on
`NaN` scores. There are 0 `catch_unwind` boundaries in the orchestration
loop — a `tool.execute_with_ctx` panic propagates as a `JoinError` and (if
spawned) crashes that task without specific handling visible in the
graph executor.

Overall: **acceptable to ship at v0.2.0-base**, but the cancellation gap
(no `kill_on_drop`, no reqwest abort) is the single highest-leverage fix
before any "kill the agent and walk away" UX promise is exposed to hosts.

---

## Findings (severity-ordered)

### BLOCKER #1: Bash subprocess survives cancellation
- **Location:**
  - `crates/wcore-config/src/shell.rs:24-29` (`shell_command_builder` —
    no `.kill_on_drop(true)`)
  - `crates/wcore-tools/src/bash.rs:231-238` (buffered path: `select!`
    drops `self.execute(input)` on cancel)
  - `crates/wcore-tools/src/bash.rs:244-257` (streaming path: same
    `select!` shape; child held in local scope, drop = orphan)
- **Failure scenario:** Agent invokes `Bash { command: "sleep 300" }`,
  user cancels. The outer `execute_with_ctx` returns a "cancelled"
  `ToolResult` in <500ms, but the `sh -c sleep 300` child remains
  alive for the full 300s. Same on the buffered timeout arm
  (`bash.rs:105` drops `shell_command(...)` future on timeout —
  orphan also). On Unix the process becomes a child of PID 1 once
  the parent goes away; on Windows the handle is closed but the
  process keeps running.
- **Impact:** Honest reliability promise of "cancel stops work" is
  violated. Long-running shell loops (`while true; do …`),
  network downloads, or compile commands keep consuming CPU/IO
  after the agent reports cancelled. Combined with `Bash` being
  the most-used tool, this is the highest-impact reliability bug
  in v0.2.0.
- **Mitigation:** Add `cmd.kill_on_drop(true)` in
  `shell_command_builder` (one line) AND keep the existing
  `select!` race. Add a regression test that spawns a `sleep 30`,
  cancels at t=200ms, then asserts the child PID exits within
  500ms (Unix) / `OpenProcess` fails (Windows). The streaming
  variant additionally needs explicit `child.start_kill()` before
  drop because it holds `Child` directly past the cancel point.

### BLOCKER #2: MCP & Browser tools acknowledge cancel but don't abort the request
- **Location:**
  - `crates/wcore-mcp/src/tool_proxy.rs:98-109` (cancel races
    `self.execute(input)` — drops the future, no `AbortHandle`)
  - `crates/wcore-browser/src/tool.rs:111-122`
    (`dispatch_inner`: `select!` between `cancel.cancelled()` and
    `self.provider.dispatch(...)`; reqwest `RequestBuilder::send()`
    inside backends is not given a `tokio::task::AbortHandle` or
    a `reqwest::Client` with a per-request timeout)
- **Failure scenario:** An MCP tool starts a 30-second JSON-RPC
  request to a slow server; user cancels. The select arm fires
  and surfaces a "cancelled" result to the engine, but the
  in-flight HTTP request continues to consume the MCP transport
  and bandwidth until completion (or the OS TCP timeout). For
  the browser tool, a navigation against an unresponsive page
  similarly streams bytes after the apparent cancel.
- **Impact:** Connection-pool exhaustion under heavy
  cancel-and-retry loops; misleading observability (the
  "cancelled" event arrives long before the resource is freed).
  The MCP comment at `tool_proxy.rs:97` is explicit about this
  ("The MCP server's tool execution continues on its own; we
  just stop awaiting the response"), making it a known-deferred
  bug rather than an oversight, but it's still a real failure
  mode.
- **Mitigation:** For MCP: drop the in-flight request via a
  `tokio::spawn` + `AbortHandle` pattern, abort on cancel. For
  browser backends: thread `CancellationToken` through the
  provider trait so the underlying `reqwest` request can be
  aborted (chromiumoxide/Browserbase backends both expose
  cancellable handles).

### MAJOR #3: `tool_search` never observes cancellation
- **Location:** `crates/wcore-tools/src/tool_search.rs:50` (only
  `execute`, no `execute_with_ctx` override → falls through to
  the default in `crates/wcore-tools/src/lib.rs:89-91` which
  ignores `ctx`).
- **Failure scenario:** `tool_search` over a large registry runs
  to completion regardless of session cancel. Likely sub-second
  in practice, but the contract documented at
  `wcore-tools/src/context.rs:37` (every tool MUST race cancel)
  is violated.
- **Impact:** Minor latency on cancel; sets a bad precedent for
  future tools that copy the missing-override pattern.
- **Mitigation:** Override `execute_with_ctx` with the standard
  `tokio::select!` pattern used by `bash`/`mcp_proxy`, returning
  a "cancelled" ToolResult on `ctx.cancel.cancelled()`.

### MAJOR #4: `ApprovalBridge` leaks senders if requester crashes
- **Location:** `crates/wcore-agent/src/approval.rs:41-48`
  (`request` inserts a `oneshot::Sender` into the pending map
  but never removes it on Drop of the receiver side).
- **Failure scenario:** Producer (ScriptTool step requesting
  approval) panics or is dropped after `request()` returned but
  before the host's `ApprovalResume` arrives. The
  `oneshot::Sender` stays in `pending` forever; the entry leaks
  memory and pollutes `pending_tokens()`.
- **Impact:** Slow memory growth under long sessions with
  ill-behaved producers; stale tokens accumulate. Not visible
  in normal operation (resume always arrives for happy-path
  flows), but exposed under crash/timeout scenarios.
- **Mitigation:** Either (a) wrap the producer-returned
  `Receiver` in a guard type that removes the pending entry on
  Drop, or (b) periodically reap entries whose `Receiver` has
  been dropped (detect via `tx.is_closed()`).

### MAJOR #5: Sub-agent relay uses `unbounded_channel`
- **Location:**
  - `crates/wcore-agent/src/spawn_tool.rs:258`
    (`mpsc::unbounded_channel::<SubAgentRelay>()`)
  - `crates/wcore-agent/src/agents/channel_sink.rs:28-54`
    (sender side; relay calls `tx.send(...)` and discards the
    result)
- **Failure scenario:** A sub-agent streams thousands of
  `TextDelta` events while the parent is busy (long tool call,
  blocking await elsewhere). With unbounded channels, the queue
  grows without bound; each `SubAgentRelay` carries a JSON
  `Value` (cloned `parent_call_id` + `agent_name`). A 10k-token
  generation = ~10k chunks = ~MB of queue.
- **Impact:** Memory pressure under bursty sub-agent streaming;
  cannot be back-pressured upstream. No `Sink::Full` indication.
- **Mitigation:** Switch to a bounded `mpsc::channel(N)` (e.g.
  256-event buffer) and have `relay()` drop or coalesce on
  `try_send` failure, OR document the unbounded choice + cap
  per-sub-agent event count at the producer.

### MAJOR #6: External-watch channel uses `unbounded_channel`
- **Location:** `crates/wcore-agent/src/watch.rs:70`
  (`mpsc::unbounded_channel::<ExternalEvent>()`)
- **Failure scenario:** File-watch storm (e.g. `git checkout` of
  a 10k-file branch or `npm install` rewriting `node_modules`)
  produces a flood of events; the consumer side reads at a
  bounded rate from an unbounded sender. Memory grows
  unboundedly until consumer catches up.
- **Impact:** OOM risk on real-world FS event storms.
- **Mitigation:** Bounded channel + coalescing on the producer
  side (matches what the `SkillWatcher::start` debounce task
  already does internally), OR a flat cap on queued events with
  oldest-drop semantics.

### MAJOR #7: Budget cost rollup is not atomic across parent + child
- **Location:**
  - `crates/wcore-agent/src/budget.rs:118-129`
    (`record_tokens`)
  - `crates/wcore-agent/src/budget.rs:132-141` (`record_cost`)
- **Failure scenario:** Two concurrent tool invocations on the
  same `ExecutionBudgetView` both call `record_cost(usd)`. Each
  takes the child write-lock, releases it, then takes the
  parent write-lock. A `first_exceeded_reason()` reader between
  the two locks sees a *partial* update: child has been
  incremented, parent has not. For tokens the saturating-add
  bounds the consequence to "off-by-one cap check", but for
  `cost_usd` the `f64 +=` (no saturation) can also briefly
  under-report the rollup. Independent: f64 `+=` on a cap close
  to `f64::MAX` saturates to infinity; check at
  `budget.rs:290-292` (`s.cost_usd > cap`) still works because
  `infinity > anything` is true, but the `observed_for` payload
  prints `$inf.0000`.
- **Impact:** Briefly under-reported cost in the parent during
  concurrent tool dispatch; "BudgetExceeded" may fire 1 tick
  later than the true crossing point under contention.
  Cosmetic on the f64 infinity tail.
- **Mitigation:** Take both write-locks under a single
  `parking_lot` guard sequence (the parent's `Arc<RwLock>` is
  already available on `self.parent`), or move to a flat global
  with per-thread sharding if contention is real. Document
  whether short-window over-spend is acceptable.

### MAJOR #8: `cancel::budget_linked_with_callback` watcher task can leak
- **Location:** `crates/wcore-agent/src/cancel.rs:42-76`
- **Failure scenario:** Self-documented in the doc comment at
  `cancel.rs:23-27`: "budgets that never trip and tokens that
  never fire keep the watcher alive for the lifetime of the
  agent session, which is acceptable for the dozen-tasks scale
  wayland-core operates at."
- **Impact:** One leaked tokio task per session that never
  budget-trips and never cancels. At scale (host process
  running thousands of sessions over hours), 50ms-polling tasks
  accumulate.
- **Mitigation:** Drive the watcher off a `watch::Sender` /
  budget-mutation signal instead of a 50ms `sleep` poll, so
  the watcher's `select!` returns naturally when the linked
  token is dropped. OR have the caller hold a `JoinHandle` and
  `abort()` it explicitly on session end.

### MAJOR #9: `PlateauDetector` never terminates on NaN scores
- **Location:** `crates/wcore-evolve/src/evolve/plateau.rs:30-48`
- **Failure scenario:** A generation produces `NaN` (e.g.
  scorer divide-by-zero, all-timeout generation where the
  scorer can't compute a meaningful number). `best - baseline`
  becomes NaN; `NaN < min_delta` is `false`; plateau is never
  declared.
- **Impact:** GEPA evolution loop runs to `max_generations`
  even when stuck; budget is consumed needlessly. Inverse risk
  (false plateau on `+inf`/`-inf` history) also exists but is
  benign — terminates early on garbage rather than spinning.
- **Mitigation:** Guard `push` against non-finite scores
  (clamp or reject with a structured error). Treat a NaN
  baseline as "max plateau" and terminate.

### MAJOR #10: `DefaultScorer` LOCKED constants are `pub` mutable fields
- **Location:** `crates/wcore-eval/src/scorer.rs:55-83`
  (`pub struct DefaultScorer { pub w_outcome: f64, … }`,
  defaults set in `impl Default`)
- **Failure scenario:** The header comment claims "Constants
  LOCKED at end of Task 3" but the fields are `pub`, so any
  caller can mutate them post-construction. The single drift
  test at `scorer.rs:218-220` only asserts
  `Default`-constructed weights sum to 1.0; it does not assert
  the *values* (0.7 / 0.2 / 0.1). A drive-by edit to defaults
  that still sums to 1.0 (e.g. 0.6 / 0.3 / 0.1) passes.
- **Impact:** "LOCKED" determinism guarantee for the
  acceptance-gate corpus is not enforced. Cross-version score
  reproducibility relies on social convention rather than test.
- **Mitigation:** Either make fields `pub(crate)` with a
  builder for testing, or add a "drift assertion" test that
  pins exact values:
  `assert_eq!(s.w_outcome, 0.7); assert_eq!(s.w_cost, 0.2); …`

### MINOR #11: `CircuitBreaker` panics on lock poisoning
- **Location:** `crates/wcore-providers/src/resilient.rs:100, 117, 133`
  (`.lock().expect("CircuitBreaker mutex")`)
- **Failure scenario:** A panic inside any of the three
  critical sections poisons the `std::sync::Mutex`. Every
  subsequent call to `before_call`/`on_success`/`on_failure`
  panics. The closing critical sections are short and
  panic-free in practice (only counter arithmetic + state
  transitions), so risk is low.
- **Impact:** A single rogue panic cascades into total
  provider-stack unavailability.
- **Mitigation:** Use `parking_lot::Mutex` (already in tree
  via `wcore-agent/budget.rs`) which doesn't have poisoning,
  or `.unwrap_or_else(|e| e.into_inner())` to keep working
  after panic.

### MINOR #12: `is_retryable` covers only `RateLimited` and `Connection`
- **Location:** `crates/wcore-providers/src/lib.rs:46-52`
- **Failure scenario:** A `ProviderError::ServerError(5xx)`
  variant (if defined) or a midway-stream EOF that gets
  surfaced as something other than `Connection` would not
  trigger the resilient retry path. From the cross-reference
  at `resilient.rs:191`, only retryable errors fall through
  to the fallback chain; everything else returns immediately.
- **Impact:** Hosts behind flaky upstream proxies that map
  502 to a non-`Connection` variant will see hard failures
  instead of fallback. Cannot confirm without enumerating the
  full `ProviderError` enum; flagging conservatively.
- **Mitigation:** Audit `ProviderError` variants and confirm
  each is correctly classified; add a test that constructs each
  variant and asserts `is_retryable()` returns the documented
  value.

### MINOR #13: SkillWatcher debounce window is 300ms, not 1s
- **Location:** `crates/wcore-skills/src/watcher.rs:119`
  (`tokio::time::sleep(Duration::from_millis(300)).await;`)
- **Failure scenario:** A multi-stage write taking longer
  than 300ms (e.g. large file rewrite + sync) will surface
  as multiple version increments rather than one. The
  300ms window is short enough that the documented "mark
  self-originated" guarantee (reload-on-own-write avoidance)
  is fragile across slow disks.
- **Impact:** Spurious version bumps on slow writes; reload
  cost amplified but no correctness issue.
- **Mitigation:** None required for correctness; consider
  bumping to 500ms or making it configurable if eyes-on
  testing shows churn under load.

### MINOR #14: Default engine output dropping
- **Location:** `crates/wcore-agent/src/agents/channel_sink.rs:46-54`
  (`let _ = self.tx.send(...)`)
- **Failure scenario:** If the parent drops the receiver
  before all sub-agent events drain, every subsequent relay
  is silently swallowed. Combined with #5 above this is
  intentional, but the silent-drop semantic means a
  prematurely-ended parent session loses sub-agent diagnostics
  that the host may have been waiting on.
- **Impact:** Hosts can't distinguish "sub-agent finished
  silently" from "sub-agent's last 50 events were dropped on
  parent shutdown."
- **Mitigation:** Emit an `Info` event at sub-agent
  termination if any send error has been observed during the
  sub-agent's life.

### MINOR #15: `serde_json::to_value` failure in ChannelSink drops the event
- **Location:** `crates/wcore-agent/src/agents/channel_sink.rs:45-48`
  ("dropping a malformed inner event is preferable to panicking")
- **Failure scenario:** A `ProtocolEvent` that fails to
  serialize (highly unlikely for derive-based serdes, but
  possible for any future variant carrying non-stringifiable
  data) is silently dropped with no log.
- **Impact:** Silent event loss.
- **Mitigation:** Emit a single `eprintln!` (or `tracing::warn`)
  on the error path so it surfaces in logs.

### INFORMATIONAL #16: No `catch_unwind` boundary around tool execution
- **Location:** Cross-cutting; checked
  `crates/wcore-agent/src/{cancel,spawn_tool,approval,spawner}.rs`
  + `orchestration/graph.rs` — only `tokio::spawn` sites, no
  `std::panic::catch_unwind` and no `FutureExt::catch_unwind`.
  Notably `orchestration/graph.rs:423` spawns each AgentCall
  but the join_all at line 475 propagates `JoinError` (which
  carries the panic) into `GraphError::AgentFailed`
  unconditionally — so a panicking sub-agent terminates the
  whole graph rather than just that node. The same pattern
  upstream (Tool dispatcher) appears to bubble panics through
  to the engine's main loop.
- **Failure scenario:** A buggy MCP tool, a malformed skill, or
  an evolve-generation Score panics inside `execute_with_ctx`.
  Best case: the spawning task returns `Err(JoinError)` and the
  caller reports a structured error. Worst case (and the case
  in graph.rs:423): the panic propagates as
  `GraphError::AgentFailed` and the entire DAG execution
  unwinds.
- **Impact:** Single-tool panic kills graph-wide execution
  rather than degrading to "that node failed, continue."
  Reduces partial-progress robustness.
- **Mitigation:** Wrap `tool.execute_with_ctx(...)` in
  `AssertUnwindSafe(fut).catch_unwind()` at the dispatcher
  level; convert caught panics into a structured
  `ToolResult { content: "tool panicked: ...", is_error: true }`
  so orchestration can decide to continue.

### INFORMATIONAL #17: Plateau detection has never seen real LLM noise
- **Location:** `crates/wcore-evolve/src/evolve/plateau.rs` plus
  `crates/wcore-evolve/tests/plateau_detection.rs` (deterministic
  tests with hand-picked f64 series).
- **Failure scenario:** W10B ships a
  `PassthroughParaphraseProvider`. The plateau detector has only
  been exercised against synthetic monotonic / noisy-dip series.
  Under real-LLM noise (variance in scorer outputs across
  generations sampled from the same prompt), the
  `min_delta=0.01` default is likely too tight; the detector
  will not declare a plateau and evolution will run to the
  generation cap. Inverse risk (early false-plateau) exists too
  but is moderated by the `window ≥ mutator_count` guidance in
  the doc comment.
- **Impact:** Wasted budget on stuck-but-not-flagged runs once
  real-LLM scoring lands.
- **Mitigation:** Collect 5-10 real-LLM runs and re-tune
  `min_delta` from the observed variance; add a deviation-aware
  plateau ("no improvement of > k*sigma over N generations")
  rather than the absolute-delta heuristic.

### INFORMATIONAL #18: Engine fixture stub channels at size 1
- **Location:** `crates/wcore-agent/src/engine.rs:1614, 1968,
  2193, 2489, 2732, 3010` (each: `let (_tx, rx) =
  tokio::sync::mpsc::channel(1)`)
- **Failure scenario:** These are all `cfg(test)` adjacent
  scaffolding (each is followed by a fixture handoff to a test
  driver). The `_tx` is intentionally dropped, so the `rx`
  fires `None` on the next recv. Pattern is fine for the
  fixture but bears re-checking if any of these sites are
  reachable from production paths.
- **Impact:** None confirmed.
- **Mitigation:** Document the intent inline (`// fixture:
  immediately-closed channel`) so future readers don't widen
  the buffer thinking it's a backpressure surface.

---

## Coverage gaps

- **Did not probe** the actual chromiumoxide / Browserbase
  backend implementations (the doc comments suggest they're
  stubs / TODO at v0.2.0; pending tasks #105 + #109 confirm).
- **Did not run** the existing test suite (`cargo test`) to
  cross-check claims; this is a static review only.
- **Did not enumerate** the full `ProviderError` enum — flagged
  MINOR #12 conservatively. A two-minute follow-up reading
  `crates/wcore-providers/src/lib.rs:31-44` resolves it.
- **Did not probe** `wcore-compact` or `wcore-memory` for race
  conditions; both are referenced from orchestration but were
  out of the audit-line scope.
- **Did not exercise** the budget watcher under real concurrent
  load (would require running the full agent against a long
  prompt). Findings about non-atomic parent+child rollup are
  static lock-order analysis only.
- **Did not check** how `BudgetExceeded` is gated against
  multiple-fire: `cancel::budget_linked_with_callback` uses
  `cb.take()` so the callback runs at most once per linked
  token, but if multiple linked tokens share the same view
  (e.g. a sub-agent budget hierarchy) each child watcher fires
  its own callback. Confirm via integration test before
  shipping a host that subscribes to `BudgetExceeded`.
- **No Windows-specific path validation** — `kill_on_drop`
  semantics differ; the mitigation in BLOCKER #1 needs
  Windows-side verification.
- **Hook system error isolation** (audit line 6) only spot-
  checked; `try_draft_skill_for_turn` at `engine.rs:594` was
  located but the body was not read end-to-end. Plan-time risk
  description ("hook panic = killed turn?") not concretely
  confirmed or refuted.
