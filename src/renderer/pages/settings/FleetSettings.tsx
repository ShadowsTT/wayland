/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fleet settings — inventory of SSH-reachable hosts (Jetson / Ubuntu servers)
 * that Wayland monitors and controls. CRUD + live reachability + a quick
 * run-command surface. Talks to the process side via ipcBridge.fleet; the
 * renderer only ever sees FleetHostPublic (no decrypted secrets).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, Input, InputNumber, Message, Modal, Select, Tag, Typography } from '@arco-design/web-react';
import { Bot, Play, Plus, RefreshCw, ServerCog, Terminal, Trash2, Wifi } from 'lucide-react';
import { ipcBridge } from '@/common';
import { useTranslation } from 'react-i18next';
import type {
  FleetCommandResult,
  FleetHostAuthType,
  FleetHostInput,
  FleetHostPublic,
  FleetHostStatus,
} from '@process/services/fleet/types';
import type { FleetDiscoveredHost } from '@process/services/fleet/FleetService';

const STATUS_COLOR: Record<FleetHostStatus, string> = {
  online: '#22c55e',
  offline: '#ef4444',
  error: '#f59e0b',
  unknown: '#6b7280',
};

type FormState = {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: FleetHostAuthType;
  privateKey: string;
  password: string;
  tags: string;
  description: string;
};

const EMPTY_FORM: FormState = {
  name: '',
  host: '',
  port: 22,
  username: 'root',
  authType: 'agent',
  privateKey: '',
  password: '',
  tags: '',
  description: '',
};

function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

const FleetSettings: React.FC = () => {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<FleetHostPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<Record<string, boolean>>({});

  // Add/edit modal
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Run-command modal
  const [runHost, setRunHost] = useState<FleetHostPublic | null>(null);
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<FleetCommandResult | null>(null);

  // Launch-agent-on-host (Fleet ↔ herdr tie-in)
  const [launchHost, setLaunchHost] = useState<FleetHostPublic | null>(null);
  const [launchCmd, setLaunchCmd] = useState('claude');
  const [launching, setLaunching] = useState(false);

  // Tailscale scan
  const [scanOpen, setScanOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [discovered, setDiscovered] = useState<FleetDiscoveredHost[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanUser, setScanUser] = useState('root');
  const [scanAuth, setScanAuth] = useState<FleetHostAuthType>('agent');
  const [scanSelected, setScanSelected] = useState<Record<string, boolean>>({});
  const [scanAdding, setScanAdding] = useState(false);

  const setField = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  const load = useCallback(async () => {
    try {
      const list = await ipcBridge.fleet.listHosts.invoke();
      setHosts(list ?? []);
    } catch (err) {
      console.error('[fleet] listHosts failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Live status: patch a single host on statusChanged pushes.
    const off = ipcBridge.fleet.statusChanged.on(({ id, status, lastSeenAt }) => {
      setHosts((prev) => prev.map((h) => (h.id === id ? { ...h, status, lastSeenAt: lastSeenAt ?? h.lastSeenAt } : h)));
    });
    return off;
  }, [load]);

  const openAdd = useCallback(() => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  }, []);

  const openEdit = useCallback((h: FleetHostPublic) => {
    setEditingId(h.id);
    setForm({
      name: h.name,
      host: h.host,
      port: h.port,
      username: h.username,
      authType: h.authType,
      privateKey: '', // never round-tripped; blank means "keep existing"
      password: '',
      tags: (h.tags ?? []).join(', '),
      description: h.description ?? '',
    });
    setEditorOpen(true);
  }, []);

  const save = useCallback(async () => {
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      Message.warning(t('settings.fleet.requiredFields', { defaultValue: 'Name, host, and username are required.' }));
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        const updates: Partial<FleetHostInput> = {
          name: form.name.trim(),
          host: form.host.trim(),
          port: form.port,
          username: form.username.trim(),
          authType: form.authType,
          tags: parseTags(form.tags),
          description: form.description.trim(),
        };
        // Only send a secret when the user typed a new one (blank = keep).
        if (form.authType === 'key' && form.privateKey.trim()) updates.privateKey = form.privateKey;
        if (form.authType === 'password' && form.password) updates.password = form.password;
        const res = await ipcBridge.fleet.updateHost.invoke({ id: editingId, updates });
        if (!res.success) throw new Error(res.error ?? 'update failed');
      } else {
        const input: FleetHostInput = {
          name: form.name.trim(),
          host: form.host.trim(),
          port: form.port,
          username: form.username.trim(),
          authType: form.authType,
          tags: parseTags(form.tags),
          description: form.description.trim(),
          ...(form.authType === 'key' && form.privateKey.trim() ? { privateKey: form.privateKey } : {}),
          ...(form.authType === 'password' && form.password ? { password: form.password } : {}),
        };
        const res = await ipcBridge.fleet.addHost.invoke(input);
        if (!res.success) throw new Error(res.error ?? 'add failed');
      }
      setEditorOpen(false);
      await load();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [editingId, form, load, t]);

  const test = useCallback(
    async (h: FleetHostPublic) => {
      setTesting((s) => ({ ...s, [h.id]: true }));
      try {
        const res = await ipcBridge.fleet.testConnection.invoke({ id: h.id });
        if (res.ok) Message.success(`${h.name}: ${t('settings.fleet.reachable', { defaultValue: 'reachable' })}${res.info ? ` (${res.info})` : ''}`);
        else Message.error(`${h.name}: ${res.error ?? t('settings.fleet.unreachable', { defaultValue: 'unreachable' })}`);
      } finally {
        setTesting((s) => ({ ...s, [h.id]: false }));
      }
    },
    [t]
  );

  const remove = useCallback(
    (h: FleetHostPublic) => {
      Modal.confirm({
        title: t('settings.fleet.removeTitle', { defaultValue: 'Remove host' }),
        content: t('settings.fleet.removeConfirm', { defaultValue: 'Remove "{{name}}" from the fleet?', name: h.name }),
        okButtonProps: { status: 'danger' },
        onOk: async () => {
          const res = await ipcBridge.fleet.removeHost.invoke({ id: h.id });
          if (res.success) await load();
          else Message.error(res.error ?? 'remove failed');
        },
      });
    },
    [load, t]
  );

  const openRun = useCallback((h: FleetHostPublic) => {
    setRunHost(h);
    setCommand('');
    setResult(null);
  }, []);

  const doRun = useCallback(async () => {
    if (!runHost || !command.trim()) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await ipcBridge.fleet.runCommand.invoke({ id: runHost.id, command: command.trim() });
      setResult(res);
    } finally {
      setRunning(false);
    }
  }, [runHost, command]);

  const openLaunch = useCallback((h: FleetHostPublic) => {
    setLaunchHost(h);
    setLaunchCmd('claude');
  }, []);

  const doLaunch = useCallback(async () => {
    if (!launchHost || !launchCmd.trim()) return;
    setLaunching(true);
    try {
      const res = await ipcBridge.fleet.launchAgent.invoke({ id: launchHost.id, agentCommand: launchCmd.trim() });
      if (res.ok) {
        Message.success(
          t('settings.fleet.agentLaunched', { defaultValue: 'Launched {{cmd}} on {{name}} — see it in Herdr', cmd: launchCmd.trim(), name: launchHost.name })
        );
        setLaunchHost(null);
      } else {
        Message.error(res.error ?? 'launch failed');
      }
    } finally {
      setLaunching(false);
    }
  }, [launchHost, launchCmd, t]);

  const doScan = useCallback(async () => {
    setScanOpen(true);
    setScanning(true);
    setScanError(null);
    setDiscovered([]);
    try {
      const res = await ipcBridge.fleet.scanTailscale.invoke();
      setDiscovered(res.hosts ?? []);
      setScanError(res.error ?? null);
      // Pre-select devices not already in the inventory.
      const existing = new Set(hosts.map((h) => h.host));
      const sel: Record<string, boolean> = {};
      (res.hosts ?? []).forEach((d) => (sel[d.host] = !existing.has(d.host)));
      setScanSelected(sel);
    } finally {
      setScanning(false);
    }
  }, [hosts]);

  const addDiscovered = useCallback(async () => {
    const toAdd = discovered.filter((d) => scanSelected[d.host]);
    if (!toAdd.length) {
      setScanOpen(false);
      return;
    }
    setScanAdding(true);
    try {
      let added = 0;
      for (const d of toAdd) {
        const res = await ipcBridge.fleet.addHost.invoke({
          name: d.name,
          host: d.host,
          port: 22,
          username: scanUser.trim() || 'root',
          authType: scanAuth,
          tags: ['tailscale'],
          description: d.os ? `Tailscale · ${d.os}` : 'Tailscale',
        });
        if (res.success) added++;
      }
      Message.success(t('settings.fleet.bulkAdded', { defaultValue: 'Added {{n}} host(s)', n: added }));
      setScanOpen(false);
      await load();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setScanAdding(false);
    }
  }, [discovered, scanSelected, scanUser, scanAuth, load, t]);

  const secretRequired = form.authType === 'key' || form.authType === 'password';

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <ServerCog size={22} />
        <Typography.Title heading={5} style={{ margin: 0 }}>
          {t('settings.fleet.title', { defaultValue: 'Fleet' })}
        </Typography.Title>
        <div style={{ flex: 1 }} />
        <Button size='small' icon={<RefreshCw size={14} />} onClick={() => void load()}>
          {t('common.refresh', { defaultValue: 'Refresh' })}
        </Button>
        <Button size='small' icon={<Wifi size={14} />} onClick={() => void doScan()}>
          {t('settings.fleet.scanTailscale', { defaultValue: 'Scan Tailscale' })}
        </Button>
        <Button type='primary' size='small' icon={<Plus size={14} />} onClick={openAdd}>
          {t('settings.fleet.addHost', { defaultValue: 'Add host' })}
        </Button>
      </div>
      <Typography.Text type='secondary' style={{ fontSize: 13 }}>
        {t('settings.fleet.subtitle', {
          defaultValue: 'SSH-reachable machines Wayland monitors and can run commands on. Agents get fleet tools via MCP.',
        })}
      </Typography.Text>

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loading ? (
          <Typography.Text type='secondary'>{t('common.loading', { defaultValue: 'Loading…' })}</Typography.Text>
        ) : hosts.length === 0 ? (
          <div style={{ border: '1px dashed var(--bg-3)', borderRadius: 8, padding: 24, textAlign: 'center' }}>
            <Typography.Text type='secondary'>
              {t('settings.fleet.empty', { defaultValue: 'No hosts yet. Add your first server or Jetson.' })}
            </Typography.Text>
          </div>
        ) : (
          hosts.map((h) => (
            <div
              key={h.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 12px',
                border: '1px solid var(--bg-3)',
                borderRadius: 8,
                background: 'var(--bg-2)',
              }}
            >
              <span
                title={h.status}
                style={{ width: 10, height: 10, borderRadius: '50%', background: STATUS_COLOR[h.status], flexShrink: 0 }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Typography.Text style={{ fontWeight: 600 }}>{h.name}</Typography.Text>
                  {(h.tags ?? []).map((tag) => (
                    <Tag key={tag} size='small' color='arcoblue'>
                      {tag}
                    </Tag>
                  ))}
                </div>
                <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                  {h.username}@{h.host}:{h.port} · {h.authType}
                  {h.lastSeenAt ? ` · seen ${new Date(h.lastSeenAt).toLocaleTimeString()}` : ''}
                </Typography.Text>
              </div>
              <Button size='mini' loading={!!testing[h.id]} onClick={() => void test(h)}>
                {t('settings.fleet.test', { defaultValue: 'Test' })}
              </Button>
              <Button size='mini' icon={<Terminal size={13} />} onClick={() => openRun(h)}>
                {t('settings.fleet.run', { defaultValue: 'Run' })}
              </Button>
              <Button size='mini' icon={<Bot size={13} />} onClick={() => openLaunch(h)}>
                {t('settings.fleet.launchAgent', { defaultValue: 'Agent' })}
              </Button>
              <Button size='mini' onClick={() => openEdit(h)}>
                {t('common.edit', { defaultValue: 'Edit' })}
              </Button>
              <Button size='mini' status='danger' icon={<Trash2 size={13} />} onClick={() => remove(h)} />
            </div>
          ))
        )}
      </div>

      {/* Add / edit modal */}
      <Modal
        title={editingId ? t('settings.fleet.editHost', { defaultValue: 'Edit host' }) : t('settings.fleet.addHost', { defaultValue: 'Add host' })}
        visible={editorOpen}
        onCancel={() => setEditorOpen(false)}
        onOk={() => void save()}
        confirmLoading={saving}
        autoFocus={false}
        style={{ width: 520 }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Input placeholder={t('settings.fleet.name', { defaultValue: 'Name (e.g. jetson-01)' })} value={form.name} onChange={(v) => setField('name', v)} />
          <div style={{ display: 'flex', gap: 8 }}>
            <Input style={{ flex: 2 }} placeholder={t('settings.fleet.hostAddr', { defaultValue: 'Host or IP' })} value={form.host} onChange={(v) => setField('host', v)} />
            <InputNumber style={{ flex: 1 }} placeholder='Port' min={1} max={65535} value={form.port} onChange={(v) => setField('port', typeof v === 'number' ? v : 22)} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Input style={{ flex: 1 }} placeholder={t('settings.fleet.username', { defaultValue: 'SSH user' })} value={form.username} onChange={(v) => setField('username', v)} />
            <Select style={{ flex: 1 }} value={form.authType} onChange={(v) => setField('authType', v as FleetHostAuthType)}>
              <Select.Option value='agent'>{t('settings.fleet.authAgent', { defaultValue: 'Agent / default keys' })}</Select.Option>
              <Select.Option value='key'>{t('settings.fleet.authKey', { defaultValue: 'Private key' })}</Select.Option>
              <Select.Option value='password'>{t('settings.fleet.authPassword', { defaultValue: 'Password (sshpass)' })}</Select.Option>
            </Select>
          </div>
          {form.authType === 'key' && (
            <Input.TextArea
              placeholder={editingId ? t('settings.fleet.keyKeep', { defaultValue: 'Paste PEM private key (leave blank to keep existing)' }) : t('settings.fleet.keyPaste', { defaultValue: 'Paste PEM private key' })}
              value={form.privateKey}
              onChange={(v) => setField('privateKey', v)}
              autoSize={{ minRows: 3, maxRows: 6 }}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
          )}
          {form.authType === 'password' && (
            <Input.Password
              placeholder={editingId ? t('settings.fleet.pwKeep', { defaultValue: 'Password (leave blank to keep existing)' }) : t('settings.fleet.pw', { defaultValue: 'Password' })}
              value={form.password}
              onChange={(v) => setField('password', v)}
            />
          )}
          <Input placeholder={t('settings.fleet.tags', { defaultValue: 'Tags, comma-separated (e.g. jetson, prod)' })} value={form.tags} onChange={(v) => setField('tags', v)} />
          <Input placeholder={t('settings.fleet.description', { defaultValue: 'Description (optional)' })} value={form.description} onChange={(v) => setField('description', v)} />
          {secretRequired && form.authType === 'password' && (
            <Typography.Text type='warning' style={{ fontSize: 12 }}>
              {t('settings.fleet.sshpassNote', { defaultValue: 'Password auth requires `sshpass` on this machine. Key or agent auth is recommended.' })}
            </Typography.Text>
          )}
        </div>
      </Modal>

      {/* Run-command modal */}
      <Modal
        title={runHost ? `${t('settings.fleet.runOn', { defaultValue: 'Run on' })} ${runHost.name}` : ''}
        visible={!!runHost}
        onCancel={() => setRunHost(null)}
        footer={null}
        style={{ width: 640 }}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <Input
            placeholder={t('settings.fleet.commandPlaceholder', { defaultValue: 'e.g. uptime && df -h /' })}
            value={command}
            onChange={setCommand}
            onPressEnter={() => void doRun()}
            style={{ fontFamily: 'monospace' }}
          />
          <Button type='primary' loading={running} icon={<Play size={14} />} onClick={() => void doRun()}>
            {t('settings.fleet.run', { defaultValue: 'Run' })}
          </Button>
        </div>
        {result && (
          <pre
            style={{
              marginTop: 12,
              maxHeight: 320,
              overflow: 'auto',
              background: 'var(--bg-1)',
              border: '1px solid var(--bg-3)',
              borderRadius: 6,
              padding: 10,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
            }}
          >
            {result.error ? `error: ${result.error}\n` : ''}
            {result.stdout}
            {result.stderr ? `\n[stderr]\n${result.stderr}` : ''}
            {`\n\n[exit ${result.exitCode ?? 'n/a'} · ${result.durationMs}ms]`}
          </pre>
        )}
      </Modal>

      {/* Launch-agent-on-host modal (Fleet ↔ herdr) */}
      <Modal
        title={launchHost ? `${t('settings.fleet.launchAgentOn', { defaultValue: 'Launch agent on' })} ${launchHost.name}` : ''}
        visible={!!launchHost}
        onCancel={() => setLaunchHost(null)}
        onOk={() => void doLaunch()}
        confirmLoading={launching}
        okText={t('settings.fleet.launch', { defaultValue: 'Launch' })}
        okButtonProps={{ disabled: !launchCmd.trim() }}
        autoFocus={false}
        style={{ width: 480 }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Select value={launchCmd} onChange={setLaunchCmd}>
            <Select.Option value='claude'>Claude</Select.Option>
            <Select.Option value='codex'>Codex</Select.Option>
          </Select>
          <Input
            addBefore={t('settings.fleet.command', { defaultValue: 'Command' })}
            value={launchCmd}
            onChange={setLaunchCmd}
            placeholder='claude'
          />
          <Typography.Text type='secondary' style={{ fontSize: 12 }}>
            {t('settings.fleet.launchAgentNote', {
              defaultValue:
                'SSHes into {{user}}@{{host}} and runs the command in a herdr pane — monitor and drive it from the Herdr page. The command must be installed on the host; requires herdr running.',
              user: launchHost?.username,
              host: launchHost?.host,
            })}
          </Typography.Text>
        </div>
      </Modal>

      {/* Tailscale discovery modal */}
      <Modal
        title={t('settings.fleet.tailscaleTitle', { defaultValue: 'Scan Tailscale' })}
        visible={scanOpen}
        onCancel={() => setScanOpen(false)}
        onOk={() => void addDiscovered()}
        okText={t('settings.fleet.addSelected', { defaultValue: 'Add selected' })}
        confirmLoading={scanAdding}
        okButtonProps={{ disabled: scanning || !discovered.some((d) => scanSelected[d.host]) }}
        style={{ width: 560 }}
      >
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <Input
            style={{ flex: 1 }}
            addBefore={t('settings.fleet.username', { defaultValue: 'SSH user' })}
            value={scanUser}
            onChange={setScanUser}
          />
          <Select style={{ width: 190 }} value={scanAuth} onChange={(v) => setScanAuth(v as FleetHostAuthType)}>
            <Select.Option value='agent'>{t('settings.fleet.authAgent', { defaultValue: 'Agent / default keys' })}</Select.Option>
            <Select.Option value='key'>{t('settings.fleet.authKey', { defaultValue: 'Private key' })}</Select.Option>
            <Select.Option value='password'>{t('settings.fleet.authPassword', { defaultValue: 'Password' })}</Select.Option>
          </Select>
        </div>
        {scanning ? (
          <Typography.Text type='secondary'>{t('settings.fleet.scanning', { defaultValue: 'Scanning Tailnet…' })}</Typography.Text>
        ) : scanError ? (
          <Typography.Text type='warning' style={{ fontSize: 13 }}>{scanError}</Typography.Text>
        ) : discovered.length === 0 ? (
          <Typography.Text type='secondary'>{t('settings.fleet.noDevices', { defaultValue: 'No Tailnet devices found.' })}</Typography.Text>
        ) : (
          <div style={{ maxHeight: 320, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {discovered.map((d) => (
              <label
                key={d.host}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  border: '1px solid var(--bg-3)',
                  borderRadius: 6,
                  cursor: 'pointer',
                }}
              >
                <Checkbox checked={!!scanSelected[d.host]} onChange={(c) => setScanSelected((s) => ({ ...s, [d.host]: c }))} />
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: d.online ? '#22c55e' : '#6b7280' }} />
                <span style={{ fontWeight: 600 }}>{d.name}</span>
                <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                  {d.host}
                  {d.os ? ` · ${d.os}` : ''}
                </Typography.Text>
              </label>
            ))}
          </div>
        )}
        <Typography.Text type='secondary' style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          {t('settings.fleet.tailscaleNote', {
            defaultValue: 'Devices are added with the SSH user + auth above (tag: tailscale). Set keys/passwords per host after.',
          })}
        </Typography.Text>
      </Modal>
    </div>
  );
};

export default FleetSettings;
