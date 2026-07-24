/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the herdr integration. herdr (~/.local/bin/herdr) is a
 * terminal workspace manager for AI coding agents that exposes a
 * newline-delimited JSON-RPC API over a Unix socket. Wayland talks to that
 * socket to monitor and control the agent panes herdr manages.
 *
 * These are the *shaped* types Wayland uses internally / over IPC — camelCased
 * and flattened from herdr's snake_case wire shapes (see HerdrService.shapeView).
 */

/** Agent liveness as reported by herdr's per-pane agent-state hooks. */
export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

/** Reference to an agent's underlying session (Claude/Codex session id or transcript path). */
export type HerdrAgentSession = {
  agent: string;
  kind: 'id' | 'path';
  source: string;
  value: string;
};

/** A single terminal pane, optionally hosting a detected AI agent. */
export type HerdrPane = {
  paneId: string;
  workspaceId: string;
  tabId: string;
  /** Agent label (e.g. "claude", "codex") when herdr detected one in this pane. */
  agent?: string;
  agentStatus: HerdrAgentStatus;
  agentSession?: HerdrAgentSession;
  /** Cleaned terminal title (spinner/ANSI stripped) — often the agent's current task. */
  title: string;
  cwd: string;
  focused: boolean;
  /** True when this pane hosts a detected agent (vs. a plain shell). */
  isAgent: boolean;
};

/** A herdr workspace (top-level project space, e.g. "wayland-main"). */
export type HerdrWorkspace = {
  workspaceId: string;
  label: string;
  number: number;
  agentStatus: HerdrAgentStatus;
  focused: boolean;
  paneCount: number;
  tabCount: number;
  panes: HerdrPane[];
};

/** The full monitor view handed to the renderer. */
export type HerdrView = {
  /** False when the herdr server socket is absent/unreachable. */
  available: boolean;
  version?: string;
  focusedWorkspaceId?: string;
  focusedPaneId?: string;
  workspaces: HerdrWorkspace[];
  error?: string;
};

/** Uniform result for the control (write) operations. */
export type HerdrActionResult = { ok: boolean; error?: string };

/** Result of reading a pane's recent output. */
export type HerdrReadResult = { ok: boolean; text?: string; error?: string };
