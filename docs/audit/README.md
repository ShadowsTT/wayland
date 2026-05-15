# Production audit reports

Versioned record of the Wayland v0.1.2 / v0.2.0 production audit deliverables. These were generated during the audit hardening branch in May 2026 and document what each phase verified.

## Historical-record note

The audit ran **before** the 2026-05-15 aionrs → wcore brand ripout (commits `5eada223a..446d8605e`). Reports authored prior to that ripout reference the legacy `aionrs` backend identifier and `#/settings/aionrs` route — those are now `wcore` and `#/settings/wcore` in the live code. The reports are preserved verbatim as a historical snapshot; only the screenshot file `13-settings-wcore.png` was renamed for filename consistency.

## Reports

| File | Phase | Scope | Verdict |
|---|---|---|---|
| [REGRESSION-REVIEW.md](REGRESSION-REVIEW.md) | Phase 1-A | Cross-commit regression hunt | 2 P0 + 1 P1 — all fixed |
| [NEW-CODE-REVIEW.md](NEW-CODE-REVIEW.md) | Phase 1-F | Review of 11 new files | 1 P0 + 2 P1 + 1 P2 — all fixed |
| [THREAT-MODEL-CHECK.md](THREAT-MODEL-CHECK.md) | Phase 1-G | Adversarial probes | 2 P0 + 1 P1 + 2 P2 — all fixed |
| [ALLOWLIST-COVERAGE.md](ALLOWLIST-COVERAGE.md) | Phase 1-B | C1 bridge-allowlist exhaustiveness | C1 holds; 4 non-bridge channels found + gated |
| [DEPS-HYGIENE.md](DEPS-HYGIENE.md) | Phase 1-H | Dep CVE + breaking-change scan | CLEAN — ship as-is |
| [DOCS-DRIFT.md](DOCS-DRIFT.md) | Phase 1-I | Docs vs code reality | 2 P0 + 4 P1 — all fixed |
| [SMOKE-FLOWS.md](SMOKE-FLOWS.md) | Phase 2-D | Every settings tab + page smoke | 21/21 PASS |
| [PERF-BASELINE.md](PERF-BASELINE.md) | Phase 2-J | Cold-start, RSS, IPC latency baseline + Q5 lazy-SDK delta | 4 of 5 wins shipped; main RSS 475→354 MB |
| [IPCMAIN-CHANNELS-AUDIT.md](IPCMAIN-CHANNELS-AUDIT.md) | Wave 2 | Non-bridge channel audit | 2 NEEDS_GATE (fixed); 3 SAFE |
| [STABILITY-v0.2.0.md](STABILITY-v0.2.0.md) | v0.2.0 | Long-run stability findings | — |
| [RELIABILITY-v0.2.0.md](RELIABILITY-v0.2.0.md) | v0.2.0 | Reliability hardening | — |
| [SECURITY-v0.2.0.md](SECURITY-v0.2.0.md) | v0.2.0 | Security review | — |
| [VALIDATION-v0.2.0.md](VALIDATION-v0.2.0.md) | v0.2.0 | Test-coverage validation | — |

## Screenshots

[`screenshots/`](screenshots/) — 21 PNGs captured during Phase 2-D smoke-flow verification. Filenames map 1:1 to the steps in [SMOKE-FLOWS.md](SMOKE-FLOWS.md).

## Adding new audit reports

Add new audit deliverables here, with a one-line entry in the table above. Use the date-stamped `*-vX.Y.Z.md` naming convention if the audit targets a specific version; otherwise the phase-named `PHASE-NAME.md` form.
