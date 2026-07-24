# Headroom agent-savings smoke fixture

This deterministic fixture exercises Headroom's `agent-90` performance and
accuracy checks for Claude, Codex, and Cursor. The numbers are synthetic; this
tests the checker and workspace wiring, not live traffic.

Run it from the repository root:

```bash
bash tests/fixtures/headroom-agent-savings/run.sh
```

Regenerate the fixture with the installed Headroom CLI:

```bash
headroom agent-savings \
  --write-smoke-fixture tests/fixtures/headroom-agent-savings
```
