/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/** Reachability of a fleet host, as last observed by a health probe. */
export type FleetHostStatus = 'unknown' | 'online' | 'offline' | 'error';

/**
 * How Wayland authenticates to a host over SSH (via the system `ssh` client):
 * - `agent`: use the host machine's ssh config / ssh-agent / default keys. No
 *   secret is stored — the simplest and most secure option when keys are set up.
 * - `key`: a PEM private key stored encrypted at rest; written to a 0600 temp
 *   file and passed via `ssh -i` for the duration of a call.
 * - `password`: a password stored encrypted at rest. Requires `sshpass` on the
 *   host machine (non-interactive password auth); flagged in the UI.
 */
export type FleetHostAuthType = 'agent' | 'key' | 'password';

/** A managed remote machine in the fleet. Secrets here are decrypted in memory. */
export interface FleetHost {
  id: string;
  name: string;
  /** Hostname or IP. */
  host: string;
  port: number;
  username: string;
  authType: FleetHostAuthType;
  /** PEM private key (authType `key`). Decrypted in memory; encrypted at rest. */
  privateKey?: string;
  /** Password (authType `password`). Decrypted in memory; encrypted at rest. */
  password?: string;
  /** Free-form labels for grouping/targeting (e.g. `jetson`, `prod`). */
  tags?: string[];
  description?: string;
  status: FleetHostStatus;
  /** Epoch ms of the last successful reach. */
  lastSeenAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * A host as exposed to the RENDERER: decrypted secrets are stripped and reduced
 * to a `hasSecret` presence flag, so private keys / passwords never cross IPC.
 * The bridge maps FleetHost -> FleetHostPublic before returning.
 */
export type FleetHostPublic = Omit<FleetHost, 'privateKey' | 'password'> & { hasSecret: boolean };

/** Fields accepted from the UI; the service fills id/status/timestamps. */
export type FleetHostInput = {
  name: string;
  host: string;
  port?: number;
  username: string;
  authType: FleetHostAuthType;
  privateKey?: string;
  password?: string;
  tags?: string[];
  description?: string;
};

/** Result of running a command on one host. */
export interface FleetCommandResult {
  hostId: string;
  /** True iff the remote command exited 0 (and ssh itself succeeded). */
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the ssh invocation itself failed (spawn/timeout/auth), not a remote non-zero exit. */
  error?: string;
  durationMs: number;
}
