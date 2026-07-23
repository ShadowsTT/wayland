/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HerdrService — high-level facade over the herdr socket API. Reads the live
 * session snapshot (shaped for the renderer) and exposes the monitor+control
 * operations Wayland surfaces: send a prompt, focus, spawn an agent, create a
 * worktree, rename, and read recent output. Every method is non-throwing at the
 * IPC boundary — failures come back as `{ ok:false, error }`.
 */

import { existsSync } from 'node:fs';
import { HerdrClient, HerdrEventStream } from './HerdrClient';
import { HERDR_MONITOR_SUBSCRIPTIONS, resolveHerdrSocketPath } from './protocol';
import type {
  HerdrActionResult,
  HerdrAgentStatus,
  HerdrPane,
  HerdrReadResult,
  HerdrView,
  HerdrWorkspace,
} from './types';

/** Raw (snake_case) shapes as they arrive on the herdr wire. */
type RawPane = {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent?: string;
  agent_status?: HerdrAgentStatus;
  agent_session?: { agent: string; kind: 'id' | 'path'; source: string; value: string };
  terminal_title_stripped?: string;
  terminal_title?: string;
  cwd?: string;
  focused?: boolean;
};

type RawWorkspace = {
  workspace_id: string;
  label?: string;
  number?: number;
  agent_status?: HerdrAgentStatus;
  focused?: boolean;
  pane_count?: number;
  tab_count?: number;
};

export type RawSnapshot = {
  version?: string;
  panes?: RawPane[];
  workspaces?: RawWorkspace[];
  focused_workspace_id?: string;
  focused_pane_id?: string;
};

const VALID_STATUS: ReadonlySet<HerdrAgentStatus> = new Set(['idle', 'working', 'blocked', 'done', 'unknown']);

function normStatus(s: HerdrAgentStatus | undefined): HerdrAgentStatus {
  return s && VALID_STATUS.has(s) ? s : 'unknown';
}

function shapePane(p: RawPane): HerdrPane {
  return {
    paneId: p.pane_id,
    workspaceId: p.workspace_id,
    tabId: p.tab_id,
    agent: p.agent,
    agentStatus: normStatus(p.agent_status),
    agentSession: p.agent_session,
    title: (p.terminal_title_stripped ?? p.terminal_title ?? '').trim(),
    cwd: p.cwd ?? '',
    focused: !!p.focused,
    isAgent: !!p.agent,
  };
}

/** Shape a raw herdr snapshot into the renderer view. Exported for testing. */
export function shapeView(snap: RawSnapshot): HerdrView {
  const panes = (snap.panes ?? []).map(shapePane);
  const byWorkspace = new Map<string, HerdrPane[]>();
  for (const pane of panes) {
    const list = byWorkspace.get(pane.workspaceId) ?? [];
    list.push(pane);
    byWorkspace.set(pane.workspaceId, list);
  }
  const workspaces: HerdrWorkspace[] = (snap.workspaces ?? []).map((w) => ({
    workspaceId: w.workspace_id,
    label: w.label ?? w.workspace_id,
    number: w.number ?? 0,
    agentStatus: normStatus(w.agent_status),
    focused: !!w.focused,
    paneCount: w.pane_count ?? 0,
    tabCount: w.tab_count ?? 0,
    // Agent panes first, then by pane id, so the dashboard leads with the agents.
    panes: (byWorkspace.get(w.workspace_id) ?? []).toSorted(
      (a, b) => Number(b.isAgent) - Number(a.isAgent) || a.paneId.localeCompare(b.paneId)
    ),
  }));
  return {
    available: true,
    version: snap.version,
    focusedWorkspaceId: snap.focused_workspace_id,
    focusedPaneId: snap.focused_pane_id,
    workspaces,
  };
}

export class HerdrService {
  private readonly socketPath: string;
  private readonly client: HerdrClient;
  private stream: HerdrEventStream | null = null;

  constructor(socketPath = resolveHerdrSocketPath()) {
    this.socketPath = socketPath;
    this.client = new HerdrClient(socketPath);
  }

  /** Cheap synchronous check: is the herdr server socket present? */
  isAvailable(): boolean {
    try {
      return existsSync(this.socketPath);
    } catch {
      return false;
    }
  }

  /** Fetch and shape the current session snapshot. */
  async getView(): Promise<HerdrView> {
    if (!this.isAvailable()) return { available: false, workspaces: [] };
    try {
      // session.snapshot replies with { snapshot: {...}, type: 'session_snapshot' }.
      const res = await this.client.request<{ snapshot?: RawSnapshot } & RawSnapshot>('session.snapshot', {});
      const snap = res?.snapshot ?? (res as RawSnapshot);
      return shapeView(snap ?? {});
    } catch (err) {
      return { available: false, workspaces: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Send a prompt to a pane. `pane.send_input` types the text and, when
   * `submit` is set, presses Enter in the same call so the agent runs it.
   */
  async sendPrompt(paneId: string, text: string, submit = true): Promise<HerdrActionResult> {
    return this.act('pane.send_input', { pane_id: paneId, text, keys: submit ? ['Enter'] : [] });
  }

  async sendKeys(paneId: string, keys: string[]): Promise<HerdrActionResult> {
    return this.act('pane.send_keys', { pane_id: paneId, keys });
  }

  async focusPane(paneId: string): Promise<HerdrActionResult> {
    return this.act('pane.focus', { pane_id: paneId });
  }

  async focusWorkspace(workspaceId: string): Promise<HerdrActionResult> {
    return this.act('workspace.focus', { workspace_id: workspaceId });
  }

  async renamePane(paneId: string, label: string): Promise<HerdrActionResult> {
    return this.act('pane.rename', { pane_id: paneId, label });
  }

  /** Spawn a new agent (e.g. name "claude", argv ["claude"]) in a workspace. */
  async startAgent(params: {
    name: string;
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
    workspaceId?: string;
    focus?: boolean;
  }): Promise<HerdrActionResult> {
    return this.act('agent.start', {
      name: params.name,
      argv: params.argv,
      cwd: params.cwd,
      env: params.env,
      workspace_id: params.workspaceId,
      focus: params.focus ?? true,
    });
  }

  /** Create a git worktree (optionally on a new branch) as a herdr workspace. */
  async createWorktree(params: {
    branch?: string;
    base?: string;
    path?: string;
    label?: string;
    cwd?: string;
    workspaceId?: string;
    focus?: boolean;
  }): Promise<HerdrActionResult> {
    return this.act('worktree.create', {
      branch: params.branch,
      base: params.base,
      path: params.path,
      label: params.label,
      cwd: params.cwd,
      workspace_id: params.workspaceId,
      focus: params.focus ?? true,
    });
  }

  /** Read a pane's recent output as plain text (ANSI stripped). */
  async readPane(paneId: string, lines = 200): Promise<HerdrReadResult> {
    if (!this.isAvailable()) return { ok: false, error: 'herdr not available' };
    try {
      const res = await this.client.request<{ text?: string; content?: string; lines?: string[] }>('pane.read', {
        pane_id: paneId,
        source: 'recent',
        lines,
        format: 'text',
        strip_ansi: true,
      });
      const text = res?.text ?? res?.content ?? (Array.isArray(res?.lines) ? res.lines.join('\n') : '');
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Subscribe to live herdr events; `onEvent` fires per pushed event. */
  subscribe(onEvent: () => void): void {
    if (this.stream) return;
    this.stream = new HerdrEventStream(this.socketPath, HERDR_MONITOR_SUBSCRIPTIONS, () => onEvent());
    this.stream.start();
  }

  dispose(): void {
    this.stream?.stop();
    this.stream = null;
  }

  /** Shared wrapper: run a write method, map success/failure to HerdrActionResult. */
  private async act(method: string, params: unknown): Promise<HerdrActionResult> {
    if (!this.isAvailable()) return { ok: false, error: 'herdr not available' };
    try {
      await this.client.request(method, params);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

let singleton: HerdrService | null = null;
export function getHerdrService(): HerdrService {
  if (!singleton) singleton = new HerdrService();
  return singleton;
}
