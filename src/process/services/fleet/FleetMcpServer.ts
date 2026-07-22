/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FleetMcpServer — the main-process half of the fleet MCP.
 *
 * Mirrors TeamMcpServer's stdio<->TCP bridge: the engine spawns a thin stdio
 * script (fleet-mcp-stdio.js) which forwards every tool call over a local
 * 127.0.0.1 TCP socket (4-byte length + JSON, token-authenticated) to this
 * server. Running the tool logic HERE keeps the DB + decrypted SSH secrets in
 * the main process — the stdio child never sees them.
 *
 * It also self-registers as a builtin IMcpServer (BUILTIN_FLEET_ID) whose stdio
 * transport env carries the live port/token, so the existing MCP-to-agent sync
 * delivers the fleet tools to every agent with no changes to the spawn path.
 */

import * as crypto from 'node:crypto';
import * as net from 'node:net';
import * as path from 'node:path';
import type { IMcpServer } from '@/common/config/storage';
import { ProcessConfig } from '@process/utils/initStorage';
import { createTcpMessageReader, resolveMcpScriptDir, writeTcpMessage } from '@process/team/mcp/tcpHelpers';
import { BUILTIN_FLEET_ID, BUILTIN_FLEET_NAME, BUILTIN_FLEET_SCRIPT } from '@process/resources/builtinMcp/constants';
import { getDatabase } from '@process/services/database';
import { getFleetService } from './FleetService';
import type { FleetCommandResult, FleetHost } from './types';

const RUN_TIMEOUT_MS = 60_000;

export class FleetMcpServer {
  private tcpServer: net.Server | null = null;
  private _port = 0;
  private readonly authToken = crypto.randomUUID();

  /** Start the TCP listener, then register/refresh the builtin MCP entry. */
  async start(): Promise<void> {
    if (this.tcpServer) return;
    this.tcpServer = net.createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.tcpServer!.listen(0, '127.0.0.1', () => {
        const addr = this.tcpServer!.address();
        if (addr && typeof addr === 'object') this._port = addr.port;
        resolve();
      });
      this.tcpServer!.once('error', reject);
    });
    console.log(`[FleetMcpServer] TCP server listening on 127.0.0.1:${this._port}`);
    await this.registerBuiltinMcp();
  }

  async stop(): Promise<void> {
    if (!this.tcpServer) return;
    await new Promise<void>((resolve) => this.tcpServer!.close(() => resolve()));
    this.tcpServer = null;
    this._port = 0;
  }

  private handleConnection(socket: net.Socket): void {
    const onData = createTcpMessageReader(
      (message: unknown) => void this.handleMessage(socket, message),
      {
        onError: (err) => {
          console.error('[FleetMcpServer] framing error:', err.message);
          socket.destroy();
        },
      }
    );
    socket.on('data', onData);
    socket.on('error', (err) => console.error('[FleetMcpServer] socket error:', err.message));
  }

  private async handleMessage(socket: net.Socket, message: unknown): Promise<void> {
    const request = message as { tool?: string; args?: Record<string, unknown>; auth_token?: string; type?: string };
    if (request.auth_token !== this.authToken) {
      writeTcpMessage(socket, { error: 'Unauthorized' });
      return;
    }
    // The stdio bridge sends a `mcp_ready` heartbeat on connect; just ack it.
    if (request.type === 'mcp_ready') {
      writeTcpMessage(socket, { result: 'ok' });
      return;
    }
    try {
      const result = await this.dispatch(request.tool ?? '', request.args ?? {});
      writeTcpMessage(socket, { result });
    } catch (err) {
      writeTcpMessage(socket, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Tool dispatch (runs with full DB + FleetService access) ─────────────────

  private async dispatch(tool: string, args: Record<string, unknown>): Promise<string> {
    const db = await getDatabase();
    const service = getFleetService();

    switch (tool) {
      case 'fleet_list_hosts': {
        const hosts = db.getFleetHosts();
        if (!hosts.length) return 'No hosts configured. Add hosts in Settings → Fleet.';
        return hosts
          .map(
            (h) =>
              `- ${h.name} — ${h.username}@${h.host}:${h.port} [${h.status}]` +
              ((h.tags ?? []).length ? ` tags: ${(h.tags ?? []).join(', ')}` : '')
          )
          .join('\n');
      }

      case 'fleet_run_command': {
        const command = String(args.command ?? '').trim();
        if (!command) return 'Error: `command` is required.';
        const targets = this.resolveTargets(db.getFleetHosts(), String(args.host ?? '*'));
        if (!targets.length) return `Error: no host matched "${String(args.host ?? '*')}".`;
        const results = await Promise.all(targets.map((h) => service.runCommand(h, command, { timeoutMs: RUN_TIMEOUT_MS })));
        return targets.map((h, i) => this.formatResult(h, results[i])).join('\n\n');
      }

      case 'fleet_health': {
        const hosts = db.getFleetHosts();
        if (!hosts.length) return 'No hosts configured.';
        const probes = await Promise.all(hosts.map(async (h) => ({ h, r: await service.probeHost(h) })));
        return probes.map(({ h, r }) => `- ${h.name}: ${r.status}${r.error ? ` (${r.error})` : ''}`).join('\n');
      }

      case 'fleet_reboot': {
        const targets = this.resolveTargets(db.getFleetHosts(), String(args.host ?? ''));
        if (!targets.length) return `Error: no host matched "${String(args.host ?? '')}".`;
        const results = await Promise.all(
          targets.map((h) => service.runCommand(h, 'sudo -n /sbin/reboot || /sbin/reboot', { timeoutMs: 15_000 }))
        );
        // A reboot usually drops the connection, so "ssh closed" is a success signal.
        return targets
          .map((h, i) => {
            const r = results[i];
            const rebooting = r.ok || /closed|reset|timed out/i.test(r.error ?? '') || /closed|reset/i.test(r.stderr);
            return `${h.name}: ${rebooting ? 'reboot issued' : `failed (${r.error || r.stderr || `exit ${r.exitCode}`})`}`;
          })
          .join('\n');
      }

      default:
        return `Error: unknown fleet tool "${tool}".`;
    }
  }

  /** Resolve a target selector to hosts: `*`/`all`, an exact name/host, or a tag. */
  private resolveTargets(hosts: FleetHost[], selector: string): FleetHost[] {
    const s = selector.trim().toLowerCase();
    if (!s || s === '*' || s === 'all') return hosts;
    const byName = hosts.filter((h) => h.name.toLowerCase() === s || h.host.toLowerCase() === s);
    if (byName.length) return byName;
    return hosts.filter((h) => (h.tags ?? []).some((t) => t.toLowerCase() === s));
  }

  private formatResult(host: FleetHost, r: FleetCommandResult): string {
    const head = `[${host.name}] ${r.error ? `error: ${r.error}` : `exit ${r.exitCode} · ${r.durationMs}ms`}`;
    const body = [r.stdout.trim(), r.stderr.trim() ? `[stderr]\n${r.stderr.trim()}` : ''].filter(Boolean).join('\n');
    return body ? `${head}\n${body}` : head;
  }

  // ── Builtin MCP registration (so agents get the tools) ──────────────────────

  private fleetScriptPath(): string {
    return path.join(resolveMcpScriptDir(), BUILTIN_FLEET_SCRIPT);
  }

  /** Upsert the fleet builtin IMcpServer with the live TCP port + token env. */
  private async registerBuiltinMcp(): Promise<void> {
    try {
      const scriptPath = this.fleetScriptPath();
      const env: Record<string, string> = {
        FLEET_MCP_PORT: String(this._port),
        FLEET_MCP_TOKEN: this.authToken,
      };
      const now = Date.now();
      const servers: IMcpServer[] = (await ProcessConfig.get('mcp.config').catch((): IMcpServer[] => [])) || [];
      const idx = servers.findIndex((s) => s.builtin === true && s.id === BUILTIN_FLEET_ID);
      const transport: IMcpServer['transport'] = { type: 'stdio', command: 'node', args: [scriptPath], env };
      const originalJson = JSON.stringify({ [BUILTIN_FLEET_NAME]: { command: 'node', args: [scriptPath], env } }, null, 2);

      if (idx >= 0) {
        // Refresh the live port/token/path (they change every boot).
        servers[idx] = { ...servers[idx], transport, originalJson, updatedAt: now };
      } else {
        servers.push({
          id: BUILTIN_FLEET_ID,
          name: BUILTIN_FLEET_NAME,
          description:
            'Monitor and control your server fleet over SSH: list hosts, run commands, check health, reboot.',
          enabled: true,
          builtin: true,
          transport,
          createdAt: now,
          updatedAt: now,
          originalJson,
          agentGuidance:
            'Use these tools to operate the user\'s server fleet. `fleet_list_hosts` shows inventory; `fleet_run_command` runs a shell command on a host (by name, tag, or "*"/"all"); `fleet_health` reports reachability; `fleet_reboot` reboots. Prefer the least-privileged command and confirm destructive actions.',
        } as IMcpServer);
      }
      await ProcessConfig.set('mcp.config', servers);
      console.log('[FleetMcpServer] Registered builtin fleet MCP server');
    } catch (err) {
      console.error('[FleetMcpServer] Failed to register builtin MCP:', err);
    }
  }
}

let singleton: FleetMcpServer | null = null;
export function getFleetMcpServer(): FleetMcpServer {
  if (!singleton) singleton = new FleetMcpServer();
  return singleton;
}
