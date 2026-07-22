/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { uuid } from '@/common/utils';
import { getDatabase } from '@process/services/database';
import { getFleetService } from '@process/services/fleet';
import { getFleetMcpServer } from '@process/services/fleet/FleetMcpServer';
import type { FleetHost, FleetHostPublic, FleetHostStatus } from '@process/services/fleet/types';

/** Strip decrypted secrets before a host crosses IPC to the renderer. */
function toPublic(host: FleetHost): FleetHostPublic {
  const { privateKey, password, ...rest } = host;
  return { ...rest, hasSecret: !!(privateKey || password) };
}

/** Background reachability polling — updates DB status + pushes statusChanged. */
const POLL_INTERVAL_MS = 60_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;

async function pollAllHosts(): Promise<void> {
  if (polling) return; // never overlap sweeps
  polling = true;
  try {
    const db = await getDatabase();
    const hosts = db.getFleetHosts();
    if (hosts.length === 0) return;
    const service = getFleetService();
    await Promise.allSettled(
      hosts.map(async (host) => {
        const { status } = await service.probeHost(host);
        const lastSeenAt = status === 'online' ? Date.now() : undefined;
        // Only emit when the status actually flips (avoid per-sweep UI churn);
        // still refresh last_seen_at for hosts that stay online.
        if (status !== host.status) {
          db.updateFleetHostStatus(host.id, status, lastSeenAt);
          ipcBridge.fleet.statusChanged.emit({ id: host.id, status, lastSeenAt });
        } else if (status === 'online') {
          db.updateFleetHostStatus(host.id, 'online', lastSeenAt);
        }
      })
    );
  } catch (err) {
    console.error('[fleet] poll error:', err);
  } finally {
    polling = false;
  }
}

export function initFleetBridge(): void {
  ipcBridge.fleet.listHosts.provider(async () => {
    const db = await getDatabase();
    return db.getFleetHosts().map(toPublic);
  });

  ipcBridge.fleet.getHost.provider(async ({ id }) => {
    const db = await getDatabase();
    const host = db.getFleetHost(id);
    return host ? toPublic(host) : null;
  });

  ipcBridge.fleet.addHost.provider(async (input) => {
    const db = await getDatabase();
    const now = Date.now();
    const host: FleetHost = {
      id: uuid(),
      name: input.name,
      host: input.host,
      port: input.port && input.port > 0 ? input.port : 22,
      username: input.username,
      authType: input.authType,
      privateKey: input.privateKey,
      password: input.password,
      tags: input.tags,
      description: input.description,
      status: 'unknown',
      createdAt: now,
      updatedAt: now,
    };
    const result = db.createFleetHost(host);
    if (!result.success || !result.data) {
      return { success: false, error: result.error ?? 'Failed to add host' };
    }
    return { success: true, host: toPublic(result.data) };
  });

  ipcBridge.fleet.updateHost.provider(async ({ id, updates }) => {
    const db = await getDatabase();
    const dbUpdates: Record<string, unknown> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.host !== undefined) dbUpdates.host = updates.host;
    if (updates.port !== undefined) dbUpdates.port = updates.port;
    if (updates.username !== undefined) dbUpdates.username = updates.username;
    if (updates.authType !== undefined) dbUpdates.auth_type = updates.authType;
    // Empty string clears the stored secret; undefined leaves it untouched.
    if (updates.privateKey !== undefined) dbUpdates.private_key = updates.privateKey;
    if (updates.password !== undefined) dbUpdates.password = updates.password;
    if (updates.tags !== undefined) dbUpdates.tags = updates.tags;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    const result = db.updateFleetHost(id, dbUpdates);
    return { success: result.success, error: result.error };
  });

  ipcBridge.fleet.removeHost.provider(async ({ id }) => {
    const db = await getDatabase();
    const result = db.deleteFleetHost(id);
    return { success: result.success, error: result.error };
  });

  ipcBridge.fleet.testConnection.provider(async ({ id }) => {
    const db = await getDatabase();
    const host = db.getFleetHost(id);
    if (!host) return { ok: false, error: 'Host not found' };
    const res = await getFleetService().testConnection(host);
    const status: FleetHostStatus = res.ok ? 'online' : 'offline';
    const lastSeenAt = res.ok ? Date.now() : undefined;
    db.updateFleetHostStatus(id, status, lastSeenAt);
    ipcBridge.fleet.statusChanged.emit({ id, status, lastSeenAt });
    return res;
  });

  ipcBridge.fleet.runCommand.provider(async ({ id, command, timeoutMs }) => {
    const db = await getDatabase();
    const host = db.getFleetHost(id);
    if (!host) {
      return { hostId: id, ok: false, exitCode: null, stdout: '', stderr: '', error: 'Host not found', durationMs: 0 };
    }
    const res = await getFleetService().runCommand(host, command, { timeoutMs });
    // A successful run proves reachability; refresh status opportunistically.
    if (res.ok) {
      db.updateFleetHostStatus(id, 'online', Date.now());
    }
    return res;
  });

  // Start the fleet MCP server (TCP bridge) and register its builtin MCP entry
  // so every agent gets fleet tools. Non-fatal if it fails — the UI still works.
  void getFleetMcpServer()
    .start()
    .catch((err) => console.error('[fleet] MCP server start failed:', err));

  // Kick off a first sweep shortly after boot, then poll on an interval.
  setTimeout(() => void pollAllHosts(), 5_000);
  pollTimer = setInterval(() => void pollAllHosts(), POLL_INTERVAL_MS);
}

/** Stop the health poller + MCP server (called on shutdown). */
export function stopFleetBridge(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  void getFleetMcpServer().stop().catch(() => {});
}
