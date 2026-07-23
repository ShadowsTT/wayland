import { describe, it, expect } from 'vitest';
import { baseSshOptions, buildRemoteAgentSshArgs, buildSshArgs } from '@process/services/fleet/sshArgs';
import type { FleetHost } from '@process/services/fleet/types';

const host = (over: Partial<FleetHost> = {}): FleetHost => ({
  id: 'h1',
  name: 'nano-46',
  host: '100.85.104.46',
  port: 22,
  username: 'nano',
  authType: 'agent',
  status: 'unknown',
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

/**
 * The remote-agent launch (Fleet ↔ herdr tie-in) must force a PTY so the agent's
 * TUI runs interactively, and must not weaken the non-interactive hardening for
 * key/agent auth. These pin the argv the herdr pane will spawn.
 */
describe('buildRemoteAgentSshArgs', () => {
  it('forces a remote PTY (-tt) and keeps BatchMode for agent auth', () => {
    const args = buildRemoteAgentSshArgs(host(), 'claude');
    expect(args[0]).toBe('-tt');
    expect(args).toContain('BatchMode=yes');
    // remote command is the final argv element, target just before it
    expect(args[args.length - 1]).toBe('claude');
    expect(args[args.length - 2]).toBe('nano@100.85.104.46');
    expect(args).toEqual(expect.arrayContaining(['-p', '22']));
  });

  it('drops BatchMode for password auth (sshpass feeds the prompt)', () => {
    const args = buildRemoteAgentSshArgs(host({ authType: 'password', password: 'pw' }), 'codex');
    expect(args).not.toContain('BatchMode=yes');
    expect(args[args.length - 1]).toBe('codex');
  });

  it('adds -i + IdentitiesOnly when an identity file is given (key auth)', () => {
    const args = buildRemoteAgentSshArgs(host({ authType: 'key' }), 'claude', { identityFile: '/tmp/k/id' });
    expect(args).toEqual(expect.arrayContaining(['-i', '/tmp/k/id', '-o', 'IdentitiesOnly=yes']));
  });

  it('honors a non-default port', () => {
    const args = buildRemoteAgentSshArgs(host({ port: 2222 }), 'claude');
    expect(args).toEqual(expect.arrayContaining(['-p', '2222']));
  });
});

describe('baseSshOptions / buildSshArgs still intact', () => {
  it('one-shot buildSshArgs has no -tt and keeps the command last', () => {
    const args = buildSshArgs(host(), 'uptime');
    expect(args).not.toContain('-tt');
    expect(args[args.length - 1]).toBe('uptime');
  });

  it('baseSshOptions omits BatchMode when batchMode:false', () => {
    expect(baseSshOptions({ batchMode: false })).not.toContain('BatchMode=yes');
  });
});
