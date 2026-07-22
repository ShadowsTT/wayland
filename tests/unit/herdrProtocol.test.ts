import { describe, it, expect, vi } from 'vitest';
import {
  createLineReader,
  encodeRequest,
  HERDR_MONITOR_SUBSCRIPTIONS,
  resolveHerdrSocketPath,
} from '@process/services/herdr/protocol';
import { shapeView, type RawSnapshot } from '@process/services/herdr/HerdrService';

/**
 * herdr's wire protocol is newline-delimited JSON over a Unix socket. These
 * cover the pure framing/parsing and the snapshot->view transform, which are
 * the parts that would silently corrupt the dashboard if they drifted.
 */
describe('resolveHerdrSocketPath', () => {
  it('prefers HERDR_SOCKET_PATH when set', () => {
    expect(resolveHerdrSocketPath({ HERDR_SOCKET_PATH: '/run/h.sock' } as NodeJS.ProcessEnv)).toBe('/run/h.sock');
  });

  it('falls back to XDG_CONFIG_HOME/herdr/herdr.sock', () => {
    expect(resolveHerdrSocketPath({ XDG_CONFIG_HOME: '/cfg' } as NodeJS.ProcessEnv)).toBe('/cfg/herdr/herdr.sock');
  });

  it('ignores a blank XDG_CONFIG_HOME and uses the home default', () => {
    const p = resolveHerdrSocketPath({ XDG_CONFIG_HOME: '   ' } as NodeJS.ProcessEnv);
    expect(p.endsWith('/.config/herdr/herdr.sock')).toBe(true);
  });
});

describe('encodeRequest', () => {
  it('emits a single newline-terminated JSON frame', () => {
    const frame = encodeRequest('id-1', 'pane.focus', { pane_id: 'w1:p1' });
    expect(frame.endsWith('\n')).toBe(true);
    expect(JSON.parse(frame)).toEqual({ id: 'id-1', method: 'pane.focus', params: { pane_id: 'w1:p1' } });
  });
});

describe('createLineReader', () => {
  it('parses one object per line and buffers partial trailing lines across chunks', () => {
    const seen: unknown[] = [];
    const read = createLineReader((m) => seen.push(m));
    read(Buffer.from('{"a":1}\n{"b":'));
    read(Buffer.from('2}\n'));
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips a malformed line without dropping the stream', () => {
    const seen: unknown[] = [];
    const read = createLineReader((m) => seen.push(m));
    read(Buffer.from('not json\n{"ok":true}\n'));
    expect(seen).toEqual([{ ok: true }]);
  });

  it('aborts and reports when the buffer cap is exceeded', () => {
    const onError = vi.fn();
    const read = createLineReader(() => {}, { maxBufferBytes: 8, onError });
    read(Buffer.from('this line has no newline and is long'));
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('HERDR_MONITOR_SUBSCRIPTIONS', () => {
  it('only subscribes to events that need no extra params (session-wide)', () => {
    // pane.agent_status_changed / pane.scroll_changed require a pane_id and must
    // not appear in the global monitor set.
    const types = HERDR_MONITOR_SUBSCRIPTIONS.map((s) => s.type);
    expect(types).toContain('pane.updated');
    expect(types).toContain('workspace.updated');
    expect(types).not.toContain('pane.agent_status_changed');
    expect(types).not.toContain('pane.scroll_changed');
  });
});

describe('shapeView', () => {
  const snap: RawSnapshot = {
    version: '0.7.4',
    focused_workspace_id: 'w2',
    focused_pane_id: 'w2:p1',
    workspaces: [{ workspace_id: 'w2', label: 'wayland-main', number: 2, agent_status: 'working', focused: true, pane_count: 2, tab_count: 1 }],
    panes: [
      { pane_id: 'w2:p2', workspace_id: 'w2', tab_id: 'w2:t1', agent_status: 'unknown', terminal_title_stripped: 'shell', cwd: '/x' },
      {
        pane_id: 'w2:p1',
        workspace_id: 'w2',
        tab_id: 'w2:t1',
        agent: 'claude',
        agent_status: 'working',
        terminal_title_stripped: 'Audit and improve app performance',
        cwd: '/x/wayland-main',
        focused: true,
      },
    ],
  };

  it('marks availability and threads version + focus through', () => {
    const view = shapeView(snap);
    expect(view.available).toBe(true);
    expect(view.version).toBe('0.7.4');
    expect(view.focusedPaneId).toBe('w2:p1');
    expect(view.workspaces).toHaveLength(1);
  });

  it('groups panes under their workspace and lists agent panes first', () => {
    const [ws] = shapeView(snap).workspaces;
    expect(ws.panes.map((p) => p.paneId)).toEqual(['w2:p1', 'w2:p2']);
    expect(ws.panes[0].isAgent).toBe(true);
    expect(ws.panes[0].agent).toBe('claude');
    expect(ws.panes[1].isAgent).toBe(false);
  });

  it('coerces an unknown agent_status to "unknown"', () => {
    const view = shapeView({ workspaces: [{ workspace_id: 'w1' }], panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'bogus' as never }] });
    expect(view.workspaces[0].panes[0].agentStatus).toBe('unknown');
  });
});
