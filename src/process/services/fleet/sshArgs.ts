/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure argv builders for the system `ssh` client. No IO — kept separate from
 * FleetService so the option/quoting logic is unit-testable in isolation
 * (architecture rule: separate pure logic from IO).
 */

import type { FleetHost } from './types';

/**
 * Non-interactive SSH hardening options.
 * - `BatchMode=yes` makes ssh fail instead of ever prompting (agent/key auth).
 *   It is deliberately OMITTED for password auth, where sshpass feeds the prompt.
 * - `StrictHostKeyChecking=accept-new` is TOFU: accept a first-seen host key but
 *   reject a CHANGED one (never blindly `no`, which ignores MITM).
 */
export function baseSshOptions(opts: { connectTimeoutSec?: number; batchMode?: boolean } = {}): string[] {
  const { connectTimeoutSec = 10, batchMode = true } = opts;
  const args: string[] = [];
  if (batchMode) args.push('-o', 'BatchMode=yes');
  args.push(
    '-o',
    `ConnectTimeout=${connectTimeoutSec}`,
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ServerAliveInterval=5',
    '-o',
    'ServerAliveCountMax=2'
  );
  return args;
}

/**
 * Build the argv passed to `ssh` (after the executable) to run `command` on
 * `host`. `identityFile`, when provided, is a path to a 0600 temp private-key
 * file (authType `key`); with `IdentitiesOnly=yes` ssh uses only that key.
 *
 * The command is passed as a single trailing argv element — ssh runs it through
 * the remote login shell. Callers must not build this from untrusted input
 * without their own quoting; the fleet inventory is operator-controlled.
 */
export function buildSshArgs(
  host: FleetHost,
  command: string,
  opts: { identityFile?: string; connectTimeoutSec?: number; batchMode?: boolean } = {}
): string[] {
  const args = baseSshOptions({ connectTimeoutSec: opts.connectTimeoutSec, batchMode: opts.batchMode });
  args.push('-p', String(host.port || 22));
  if (opts.identityFile) {
    args.push('-i', opts.identityFile, '-o', 'IdentitiesOnly=yes');
  }
  args.push(`${host.username}@${host.host}`, command);
  return args;
}

/**
 * Build the argv for `ssh` to launch an INTERACTIVE agent (`remoteCommand`, e.g.
 * `claude`) on `host`. Unlike buildSshArgs (one-shot, captured output), this
 * forces a remote PTY (`-tt`) so the agent's terminal UI runs interactively
 * inside the herdr pane that hosts the ssh process. BatchMode stays on for
 * agent/key auth (fail fast, never hang on a prompt) and is left off for
 * password auth, where sshpass feeds the prompt.
 */
export function buildRemoteAgentSshArgs(
  host: FleetHost,
  remoteCommand: string,
  opts: { identityFile?: string; connectTimeoutSec?: number } = {}
): string[] {
  const batchMode = host.authType !== 'password';
  // -tt: force PTY allocation even though ssh's own stdin is a pipe from herdr.
  const args = ['-tt', ...baseSshOptions({ connectTimeoutSec: opts.connectTimeoutSec, batchMode })];
  args.push('-p', String(host.port || 22));
  if (opts.identityFile) {
    args.push('-i', opts.identityFile, '-o', 'IdentitiesOnly=yes');
  }
  args.push(`${host.username}@${host.host}`, remoteCommand);
  return args;
}
