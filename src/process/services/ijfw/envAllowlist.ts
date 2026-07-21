/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * IJFW env allowlist - strictly forwards only known-safe env vars to spawned
 * children. Fixes SEC-005 (no prefix match - exact IJFW_* keys only).
 */

// Matched CASE-INSENSITIVELY (stored lower-cased). Windows env var names carry
// arbitrary casing (`Path`, `SystemRoot`, `Temp`, ...); an exact case-sensitive
// match silently dropped every one of them. Most critically it dropped
// `SystemRoot`, without which a spawned Node child ABORTS at startup
// ("Assertion failed: ncrypto::CSPRNG(nullptr, 0)" in InitializeOncePerProcess)
// because its CSPRNG cannot initialize — which broke the IJFW memory runtime AND
// the npx auto-installer on Windows (both spawn Node through this allowlist).
const ALLOW_EXACT_LOWER = new Set<string>(
  [
    'PATH',
    'HOME',
    'NODE_ENV',
    'ELECTRON_RUN_AS_NODE',
    'LANG',
    'LC_ALL',
    'TZ',
    'TMPDIR',
    'TEMP',
    'TMP',
    'USER',
    'USERNAME',
    'LOGNAME',
    // Windows: a spawned Node child needs these to boot and behave. SystemRoot/
    // SystemDrive/windir seed the CSPRNG + resolve system DLLs; USERPROFILE/APPDATA/
    // LOCALAPPDATA let os.homedir() find ~/.ijfw and npm/npx find their caches;
    // PATHEXT/COMSPEC let the installer child shell out. None are secrets.
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PATHEXT',
    'COMSPEC',
    // Exact IJFW_* keys we forward (SEC-005 - never prefix-match, still exact even
    // when compared case-insensitively).
    'IJFW_AUTO_INSTALL',
    'IJFW_HOME',
    'IJFW_LOG_LEVEL',
  ].map((k) => k.toLowerCase())
);

const EXTRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function buildChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // Preserve the original key casing in the child env (Node/Windows read
    // `SystemRoot`, not `SYSTEMROOT`); only the MATCH is case-insensitive.
    if (ALLOW_EXACT_LOWER.has(k.toLowerCase())) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (!EXTRA_KEY_PATTERN.test(k)) {
      throw new Error(`invalid env key: ${k}`);
    }
    out[k] = v;
  }
  return out;
}
