#!/usr/bin/env bash

set -euo pipefail

fixture_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v headroom >/dev/null 2>&1; then
  echo "headroom is not installed or is not on PATH" >&2
  exit 127
fi

HEADROOM_UPDATE_CHECK=off \
  HEADROOM_WORKSPACE_DIR="$fixture_dir" \
  headroom agent-savings \
  --check-perf \
  --hours 0 \
  --require-agents claude,codex,cursor \
  --accuracy-report "$fixture_dir/agent-90-eval.json"
