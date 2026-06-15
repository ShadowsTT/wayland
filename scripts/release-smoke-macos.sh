#!/usr/bin/env bash
#
# release-smoke-macos.sh — the macOS install gate.
#
# Verifies a *published* (or local) dmg the way a real user's Mac does: it
# stamps the Safari quarantine bit, runs Gatekeeper against the disk image AND
# the app inside, and validates both notarization tickets offline. A green run
# means a user who double-clicks the download will NOT see "damaged" or an
# "unidentified developer" wall.
#
# This exists because notarization has TWO separate tickets — one on the .app,
# one on the .dmg — and a build can staple the app while leaving the dmg
# unsigned. That shipped once (rc.2.1 → "Wayland is damaged"). This gate makes
# that state a hard release failure instead of a user discovery.
#
# Usage:
#   scripts/release-smoke-macos.sh --tag v0.9.6-rc.2.1     # download from the release (gh)
#   scripts/release-smoke-macos.sh --dmg path/to/file.dmg  # one local dmg
#   scripts/release-smoke-macos.sh --dmg a.dmg --dmg b.dmg # several
#
# Exit code: 0 = all dmgs pass, 1 = any check failed (do NOT publish/announce).

set -uo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "FAIL: this gate must run on macOS (Gatekeeper is macOS-only)." >&2
  exit 1
fi

TAG=""
DMGS=()
WORKDIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --dmg) DMGS+=("$2"); shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$TAG" ]]; then
  WORKDIR="$(mktemp -d)"
  echo "==> Downloading dmgs for $TAG from the release (gh release download)…"
  if ! gh release download "$TAG" --pattern '*.dmg' --dir "$WORKDIR" --clobber; then
    echo "FAIL: could not download dmgs for $TAG (is the release/draft present and gh authed?)." >&2
    exit 1
  fi
  while IFS= read -r f; do DMGS+=("$f"); done < <(find "$WORKDIR" -name '*.dmg')
fi

if [[ ${#DMGS[@]} -eq 0 ]]; then
  echo "FAIL: no dmgs to check. Pass --tag <tag> or --dmg <path>." >&2
  exit 1
fi

QUARANTINE_VALUE="0083;00000000;Safari;F1A2B3C4-0000-0000-0000-000000000000"
overall_fail=0

# check <label> <command...> — runs a check, prints PASS/FAIL, tracks failures.
dmg_fail=0
check() {
  local label="$1"; shift
  if "$@" >/tmp/smoke-check.out 2>&1; then
    echo "    PASS  $label"
  else
    echo "    FAIL  $label"
    sed 's/^/          /' /tmp/smoke-check.out
    dmg_fail=1
  fi
}

# spctl/codesign succeed (exit 0) only when Gatekeeper *accepts*; their non-zero
# exit on rejection is exactly the signal we want, so we use them directly.
assess_dmg()      { spctl -a -t open --context context:primary-signature -vv "$1"; }
validate_ticket() { xcrun stapler validate "$1"; }
assess_app()      { spctl -a -t exec -vv "$1"; }
verify_app_sig()  { codesign --verify --deep --strict --verbose=2 "$1"; }

for dmg in "${DMGS[@]}"; do
  echo
  echo "================================================================"
  echo "DMG: $dmg"
  echo "================================================================"
  dmg_fail=0

  if [[ ! -f "$dmg" ]]; then
    echo "    FAIL  file not found"
    overall_fail=1
    continue
  fi

  # Simulate exactly what Safari does to a download: stamp the quarantine bit.
  # Work on a copy so a passed-in artifact isn't mutated.
  scratch="$(mktemp -d)"
  work="$scratch/$(basename "$dmg")"
  cp "$dmg" "$work"
  xattr -w com.apple.quarantine "$QUARANTINE_VALUE" "$work" 2>/dev/null || true

  echo "  [disk image — what the user double-clicks]"
  check "Gatekeeper accepts the quarantined dmg (no 'damaged')" assess_dmg "$work"
  check "dmg has a stapled notarization ticket"                 validate_ticket "$work"

  echo "  [app inside the dmg]"
  mp="$(hdiutil attach "$work" -nobrowse -noverify -noautoopen 2>/dev/null | grep -o '/Volumes/.*' | head -1)"
  if [[ -z "$mp" ]]; then
    echo "    FAIL  could not mount dmg"
    dmg_fail=1
  else
    app="$(find "$mp" -maxdepth 1 -name '*.app' | head -1)"
    if [[ -z "$app" ]]; then
      echo "    FAIL  no .app found inside the dmg"
      dmg_fail=1
    else
      check "Gatekeeper accepts the app (Notarized Developer ID)" assess_app "$app"
      check "app code signature is valid (deep, strict)"          verify_app_sig "$app"
      check "app has a stapled notarization ticket"               validate_ticket "$app"
    fi
    hdiutil detach "$mp" -quiet 2>/dev/null || hdiutil detach "$mp" -force -quiet 2>/dev/null || true
  fi

  rm -rf "$scratch"

  if [[ $dmg_fail -ne 0 ]]; then
    echo "  RESULT: ❌ FAIL — this dmg would show 'damaged' or a Gatekeeper wall."
    overall_fail=1
  else
    echo "  RESULT: ✅ PASS — clean double-click install."
  fi
done

[[ -n "$WORKDIR" ]] && rm -rf "$WORKDIR"

# Update-feed integrity. A dmg can be perfectly notarized yet ship a stale
# latest*.yml hash — the bytes change when the dmg is stapled AFTER the manifest
# is written — and electron-updater then rejects every in-app update with
# "checksum mismatch" (#109, 0.9.8). The Gatekeeper checks above do NOT catch
# that, so verify the manifests against the real artifacts here and make a
# mismatch a hard release failure too. Only meaningful against a real tag.
if [[ -n "$TAG" ]]; then
  echo
  echo "================================================================"
  echo "Update-feed manifest integrity ($TAG)"
  echo "================================================================"
  if node "$(dirname "$0")/verify-update-metadata.mjs" --tag "$TAG"; then
    echo "  RESULT: ✅ PASS — every latest*.yml matches its artifacts."
  else
    echo "  RESULT: ❌ FAIL — update manifest does not match the published artifacts."
    overall_fail=1
  fi
fi

echo
if [[ $overall_fail -ne 0 ]]; then
  echo "########################################################"
  echo "# RELEASE SMOKE (macOS): FAIL — DO NOT PUBLISH/ANNOUNCE #"
  echo "########################################################"
  exit 1
fi
echo "########################################################"
echo "# RELEASE SMOKE (macOS): PASS — safe to publish        #"
echo "########################################################"
exit 0
