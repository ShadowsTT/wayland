/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FleetService — runs commands on remote hosts over the system `ssh` client.
 *
 * Deliberately shells out to `ssh` (and `sshpass` for password auth) instead of
 * bundling a JS SSH library: no new native/JS dependency, reuses the host
 * machine's ssh config / known_hosts / agent, and lines up with Ansible (which
 * also drives system ssh). Pure argv construction lives in sshArgs.ts.
 *
 * Every method is non-throwing: auth failures, timeouts, and non-zero remote
 * exits are returned as data, never exceptions.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEnhancedEnv } from '@process/utils/shellEnv';
import { buildRemoteAgentSshArgs, buildSshArgs } from './sshArgs';
import type { FleetCommandResult, FleetHost, FleetHostStatus } from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
/** Cap captured output per stream so a runaway command can't exhaust memory. */
const MAX_OUTPUT_BYTES = 1_000_000;

export class FleetService {
  /**
   * Run `command` on `host` over SSH. For authType `key` a per-call 0600 temp
   * key file is written and removed in `finally`.
   */
  async runCommand(
    host: FleetHost,
    command: string,
    opts: { timeoutMs?: number; connectTimeoutSec?: number } = {}
  ): Promise<FleetCommandResult> {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let keyDir: string | undefined;
    let exe = 'ssh';
    const sshArgsOpts: { identityFile?: string; connectTimeoutSec?: number; batchMode?: boolean } = {
      connectTimeoutSec: opts.connectTimeoutSec,
    };
    const env: NodeJS.ProcessEnv = { ...getEnhancedEnv() };

    try {
      if (host.authType === 'key') {
        if (!host.privateKey) return this.fail(host.id, started, 'No private key configured for this host');
        keyDir = mkdtempSync(join(tmpdir(), 'wl-fleet-'));
        const identityFile = join(keyDir, 'id');
        writeFileSync(identityFile, host.privateKey.endsWith('\n') ? host.privateKey : `${host.privateKey}\n`, {
          mode: 0o600,
        });
        sshArgsOpts.identityFile = identityFile;
      } else if (host.authType === 'password') {
        if (!host.password) return this.fail(host.id, started, 'No password configured for this host');
        exe = 'sshpass';
        sshArgsOpts.batchMode = false; // sshpass feeds the password prompt, so BatchMode must be off
        env.SSHPASS = host.password;
      }

      const sshArgs = buildSshArgs(host, command, sshArgsOpts);
      const argv = exe === 'sshpass' ? ['-e', 'ssh', ...sshArgs] : sshArgs;
      return await this.spawnCapture(exe, argv, env, timeoutMs, host.id, started);
    } catch (err) {
      return this.fail(host.id, started, err instanceof Error ? err.message : String(err));
    } finally {
      if (keyDir) {
        try {
          rmSync(keyDir, { recursive: true, force: true });
        } catch {
          // best-effort temp cleanup
        }
      }
    }
  }

  private spawnCapture(
    exe: string,
    argv: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    hostId: string,
    started: number
  ): Promise<FleetCommandResult> {
    return new Promise((resolve) => {
      const child = spawn(exe, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const cap = (buf: string, chunk: string): string =>
        buf.length >= MAX_OUTPUT_BYTES ? buf : (buf + chunk).slice(0, MAX_OUTPUT_BYTES);
      child.stdout?.on('data', (d: Buffer) => (stdout = cap(stdout, d.toString())));
      child.stderr?.on('data', (d: Buffer) => (stderr = cap(stderr, d.toString())));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        const msg =
          err.code === 'ENOENT'
            ? exe === 'sshpass'
              ? 'sshpass not installed (required for password auth)'
              : 'ssh client not found on this machine'
            : err.message;
        resolve(this.fail(hostId, started, msg, stdout, stderr));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve(this.fail(hostId, started, `Timed out after ${timeoutMs}ms`, stdout, stderr));
          return;
        }
        resolve({ hostId, ok: code === 0, exitCode: code, stdout, stderr, durationMs: Date.now() - started });
      });
    });
  }

  private fail(hostId: string, started: number, error: string, stdout = '', stderr = ''): FleetCommandResult {
    return { hostId, ok: false, exitCode: null, stdout, stderr, error, durationMs: Date.now() - started };
  }

  /**
   * Prepare an SSH launch of an interactive agent (`agentCommand`, e.g. `claude`)
   * on `host`, to be spawned as a herdr pane so it shows up in the Herdr monitor.
   * Returns the argv + env for herdr's `agent.start`.
   *
   * Auth handling mirrors runCommand, with one difference: the herdr pane is
   * long-lived, so for `key` auth the decrypted key is written to a 0600 temp
   * file that must PERSIST for the session (ssh may re-read it on reconnect) —
   * it is not deleted here. `agent`/default-key auth leaves no secret on disk and
   * is the recommended option for remote agents.
   */
  prepareRemoteAgentLaunch(host: FleetHost, agentCommand: string): { name: string; argv: string[]; env: Record<string, string> } {
    const command = agentCommand.trim();
    if (!command) throw new Error('Agent command is required');
    const label = command.split(/\s+/)[0];
    const name = `${label}@${host.name}`;
    const env: Record<string, string> = { ...getEnhancedEnv() } as Record<string, string>;

    let identityFile: string | undefined;
    let exe: 'ssh' | 'sshpass' = 'ssh';

    if (host.authType === 'key') {
      if (!host.privateKey) throw new Error('No private key configured for this host');
      const keyDir = mkdtempSync(join(tmpdir(), 'wl-fleet-agent-'));
      identityFile = join(keyDir, 'id');
      writeFileSync(identityFile, host.privateKey.endsWith('\n') ? host.privateKey : `${host.privateKey}\n`, { mode: 0o600 });
    } else if (host.authType === 'password') {
      if (!host.password) throw new Error('No password configured for this host');
      exe = 'sshpass';
      env.SSHPASS = host.password;
    }

    const sshArgs = buildRemoteAgentSshArgs(host, command, { identityFile });
    const argv = exe === 'sshpass' ? ['sshpass', '-e', 'ssh', ...sshArgs] : ['ssh', ...sshArgs];
    return { name, argv, env };
  }

  /** Cheap reachability check (used by testConnection UI + status polling). */
  async testConnection(host: FleetHost): Promise<{ ok: boolean; error?: string; info?: string }> {
    const res = await this.runCommand(host, 'echo wayland-ok && uname -sm', {
      timeoutMs: 15_000,
      connectTimeoutSec: 10,
    });
    if (res.ok && res.stdout.includes('wayland-ok')) {
      const info = res.stdout.replace('wayland-ok', '').trim();
      return { ok: true, info: info || undefined };
    }
    return { ok: false, error: res.error || res.stderr.trim() || `ssh exited with code ${res.exitCode}` };
  }

  /** Reachability probe mapped to a status for the DB/UI. */
  async probeHost(host: FleetHost): Promise<{ status: FleetHostStatus; error?: string }> {
    const res = await this.testConnection(host);
    return res.ok ? { status: 'online' } : { status: 'offline', error: res.error };
  }

  /**
   * Discover machines on the user's Tailnet via `tailscale status --json`.
   * Returns each peer's Tailscale IP + hostname so the UI can bulk-add them.
   * Never throws: an absent/erroring `tailscale` CLI yields an empty list.
   */
  async scanTailscale(): Promise<{ hosts: FleetDiscoveredHost[]; error?: string }> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn('tailscale', ['status', '--json'], { env: { ...getEnhancedEnv() }, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        resolve({ hosts: [], error: 'tailscale CLI not found on this machine' });
        return;
      }
      let out = '';
      let err = '';
      child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
      child.on('error', (e: NodeJS.ErrnoException) => {
        resolve({ hosts: [], error: e.code === 'ENOENT' ? 'tailscale CLI not found on this machine' : e.message });
      });
      child.on('close', (code) => {
        if (code !== 0) {
          resolve({ hosts: [], error: err.trim() || `tailscale exited with code ${code}` });
          return;
        }
        try {
          resolve({ hosts: parseTailscaleStatus(out) });
        } catch (e) {
          resolve({ hosts: [], error: e instanceof Error ? e.message : 'Failed to parse tailscale output' });
        }
      });
    });
  }
}

/** A machine discovered on the Tailnet (not yet added; no credentials known). */
export interface FleetDiscoveredHost {
  name: string;
  host: string;
  os?: string;
  online: boolean;
}

/** Pure parser for `tailscale status --json` -> discovered hosts (self + peers). */
export function parseTailscaleStatus(json: string): FleetDiscoveredHost[] {
  const status = JSON.parse(json) as {
    Self?: TailscalePeer;
    Peer?: Record<string, TailscalePeer>;
  };
  const peers: TailscalePeer[] = [
    ...(status.Self ? [status.Self] : []),
    ...(status.Peer ? Object.values(status.Peer) : []),
  ];
  const seen = new Set<string>();
  const hosts: FleetDiscoveredHost[] = [];
  for (const p of peers) {
    const ip = (p.TailscaleIPs ?? []).find((a) => a.includes('.')) ?? (p.TailscaleIPs ?? [])[0];
    if (!ip || seen.has(ip)) continue;
    seen.add(ip);
    const name = (p.HostName || p.DNSName || ip).replace(/\.$/, '').split('.')[0];
    hosts.push({ name, host: ip, os: p.OS, online: !!p.Online });
  }
  return hosts;
}

interface TailscalePeer {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  OS?: string;
  Online?: boolean;
}

let singleton: FleetService | null = null;
export function getFleetService(): FleetService {
  if (!singleton) singleton = new FleetService();
  return singleton;
}
