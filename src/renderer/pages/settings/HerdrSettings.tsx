/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Herdr settings — live dashboard for the AI agent panes herdr manages on this
 * machine (Claude/Codex terminals grouped by workspace). Monitors agent status
 * in real time and drives panes: send a prompt, focus, read recent output,
 * rename, and spawn new agents. Talks to the process side via ipcBridge.herdr.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Input, Message, Modal, Select, Tag, Typography } from '@arco-design/web-react';
import { Boxes, Bot, Plus, RefreshCw, ScrollText, Send, Target, Terminal } from 'lucide-react';
import { ipcBridge } from '@/common';
import { useTranslation } from 'react-i18next';
import type { HerdrAgentStatus, HerdrPane, HerdrView } from '@process/services/herdr/types';

const STATUS_COLOR: Record<HerdrAgentStatus, string> = {
  working: '#22c55e',
  idle: '#3b82f6',
  blocked: '#f59e0b',
  done: '#14b8a6',
  unknown: '#6b7280',
};

const STATUS_LABEL: Record<HerdrAgentStatus, string> = {
  working: 'working',
  idle: 'idle',
  blocked: 'blocked',
  done: 'done',
  unknown: 'unknown',
};

const EMPTY_VIEW: HerdrView = { available: false, workspaces: [] };

const HerdrSettings: React.FC = () => {
  const { t } = useTranslation();
  const [view, setView] = useState<HerdrView>(EMPTY_VIEW);
  const [loading, setLoading] = useState(true);

  // Send-prompt modal
  const [promptPane, setPromptPane] = useState<HerdrPane | null>(null);
  const [promptText, setPromptText] = useState('');
  const [submitOnSend, setSubmitOnSend] = useState(true);
  const [sending, setSending] = useState(false);

  // Output modal
  const [outputPane, setOutputPane] = useState<HerdrPane | null>(null);
  const [outputText, setOutputText] = useState('');
  const [loadingOutput, setLoadingOutput] = useState(false);

  // New-agent modal
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentCmd, setAgentCmd] = useState('claude');
  const [agentCwd, setAgentCwd] = useState('');
  const [agentWorkspace, setAgentWorkspace] = useState<string | undefined>(undefined);
  const [startingAgent, setStartingAgent] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await ipcBridge.herdr.getView.invoke();
      setView(v ?? EMPTY_VIEW);
    } catch (err) {
      console.error('[herdr] getView failed', err);
      setView(EMPTY_VIEW);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Live: the process side pushes a freshly-shaped view on any herdr change.
    const off = ipcBridge.herdr.changed.on((v) => setView(v ?? EMPTY_VIEW));
    return off;
  }, [load]);

  const totalAgents = useMemo(
    () => view.workspaces.reduce((n, w) => n + w.panes.filter((p) => p.isAgent).length, 0),
    [view]
  );

  const openPrompt = useCallback((pane: HerdrPane) => {
    setPromptPane(pane);
    setPromptText('');
    setSubmitOnSend(true);
  }, []);

  const doSendPrompt = useCallback(async () => {
    if (!promptPane || !promptText.trim()) return;
    setSending(true);
    try {
      const res = await ipcBridge.herdr.sendPrompt.invoke({
        paneId: promptPane.paneId,
        text: promptText,
        submit: submitOnSend,
      });
      if (res.ok) {
        Message.success(t('settings.herdr.sent', { defaultValue: 'Sent' }));
        setPromptPane(null);
      } else {
        Message.error(res.error ?? 'send failed');
      }
    } finally {
      setSending(false);
    }
  }, [promptPane, promptText, submitOnSend, t]);

  const openOutput = useCallback(
    async (pane: HerdrPane) => {
      setOutputPane(pane);
      setOutputText('');
      setLoadingOutput(true);
      try {
        const res = await ipcBridge.herdr.readPane.invoke({ paneId: pane.paneId, lines: 200 });
        setOutputText(res.ok ? res.text ?? '' : `error: ${res.error ?? 'read failed'}`);
      } finally {
        setLoadingOutput(false);
      }
    },
    []
  );

  const focusPane = useCallback(
    async (pane: HerdrPane) => {
      const res = await ipcBridge.herdr.focusPane.invoke({ paneId: pane.paneId });
      if (!res.ok) Message.error(res.error ?? 'focus failed');
    },
    []
  );

  const doStartAgent = useCallback(async () => {
    const argv = agentCmd.trim().split(/\s+/).filter(Boolean);
    if (!argv.length) {
      Message.warning(t('settings.herdr.cmdRequired', { defaultValue: 'A command is required.' }));
      return;
    }
    setStartingAgent(true);
    try {
      const res = await ipcBridge.herdr.startAgent.invoke({
        name: argv[0],
        argv,
        cwd: agentCwd.trim() || undefined,
        workspaceId: agentWorkspace,
        focus: true,
      });
      if (res.ok) {
        Message.success(t('settings.herdr.agentStarted', { defaultValue: 'Agent started' }));
        setAgentOpen(false);
        await load();
      } else {
        Message.error(res.error ?? 'start failed');
      }
    } finally {
      setStartingAgent(false);
    }
  }, [agentCmd, agentCwd, agentWorkspace, load, t]);

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <Boxes size={22} />
        <Typography.Title heading={5} style={{ margin: 0 }}>
          {t('settings.herdr.title', { defaultValue: 'Herdr' })}
        </Typography.Title>
        {view.available && (
          <Tag size='small' color='arcoblue'>
            {t('settings.herdr.agentCount', { defaultValue: '{{n}} agents', n: totalAgents })}
          </Tag>
        )}
        <div style={{ flex: 1 }} />
        <Button size='small' icon={<RefreshCw size={14} />} onClick={() => void load()}>
          {t('common.refresh', { defaultValue: 'Refresh' })}
        </Button>
        <Button
          type='primary'
          size='small'
          icon={<Plus size={14} />}
          disabled={!view.available}
          onClick={() => {
            setAgentCmd('claude');
            setAgentCwd('');
            setAgentWorkspace(view.focusedWorkspaceId);
            setAgentOpen(true);
          }}
        >
          {t('settings.herdr.newAgent', { defaultValue: 'New agent' })}
        </Button>
      </div>
      <Typography.Text type='secondary' style={{ fontSize: 13 }}>
        {t('settings.herdr.subtitle', {
          defaultValue: 'Live view of the AI agent terminals herdr manages on this machine. Monitor status and drive them without leaving Wayland.',
        })}
      </Typography.Text>

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {loading ? (
          <Typography.Text type='secondary'>{t('common.loading', { defaultValue: 'Loading…' })}</Typography.Text>
        ) : !view.available ? (
          <div style={{ border: '1px dashed var(--bg-3)', borderRadius: 8, padding: 24, textAlign: 'center' }}>
            <Typography.Text type='secondary'>
              {t('settings.herdr.unavailable', {
                defaultValue: 'herdr not detected. Start the herdr server to monitor and control your agent workspaces.',
              })}
            </Typography.Text>
          </div>
        ) : view.workspaces.length === 0 ? (
          <div style={{ border: '1px dashed var(--bg-3)', borderRadius: 8, padding: 24, textAlign: 'center' }}>
            <Typography.Text type='secondary'>
              {t('settings.herdr.empty', { defaultValue: 'No herdr workspaces open.' })}
            </Typography.Text>
          </div>
        ) : (
          view.workspaces.map((ws) => (
            <div
              key={ws.workspaceId}
              style={{ border: '1px solid var(--bg-3)', borderRadius: 8, background: 'var(--bg-2)', overflow: 'hidden' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid var(--bg-3)' }}>
                <span
                  title={STATUS_LABEL[ws.agentStatus]}
                  style={{ width: 10, height: 10, borderRadius: '50%', background: STATUS_COLOR[ws.agentStatus], flexShrink: 0 }}
                />
                <Typography.Text style={{ fontWeight: 600 }}>{ws.label}</Typography.Text>
                {ws.focused && (
                  <Tag size='small' color='green'>
                    {t('settings.herdr.focused', { defaultValue: 'focused' })}
                  </Tag>
                )}
                <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                  {ws.paneCount} {t('settings.herdr.panes', { defaultValue: 'panes' })}
                </Typography.Text>
                <div style={{ flex: 1 }} />
                <Button size='mini' icon={<Target size={13} />} onClick={() => void ipcBridge.herdr.focusWorkspace.invoke({ workspaceId: ws.workspaceId })}>
                  {t('settings.herdr.focus', { defaultValue: 'Focus' })}
                </Button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {ws.panes.map((pane) => (
                  <div
                    key={pane.paneId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      opacity: pane.isAgent ? 1 : 0.6,
                    }}
                  >
                    <span
                      title={STATUS_LABEL[pane.agentStatus]}
                      style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[pane.agentStatus], flexShrink: 0 }}
                    />
                    {pane.isAgent ? <Bot size={15} /> : <Terminal size={15} />}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Typography.Text style={{ fontWeight: pane.isAgent ? 600 : 400 }}>
                          {pane.agent ?? t('settings.herdr.shell', { defaultValue: 'shell' })}
                        </Typography.Text>
                        <Typography.Text type='secondary' style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {pane.title}
                        </Typography.Text>
                      </div>
                      <Typography.Text type='secondary' style={{ fontSize: 11 }}>
                        {pane.paneId} · {pane.cwd}
                      </Typography.Text>
                    </div>
                    <Button size='mini' type='primary' icon={<Send size={13} />} onClick={() => openPrompt(pane)}>
                      {t('settings.herdr.prompt', { defaultValue: 'Prompt' })}
                    </Button>
                    <Button size='mini' icon={<ScrollText size={13} />} onClick={() => void openOutput(pane)}>
                      {t('settings.herdr.output', { defaultValue: 'Output' })}
                    </Button>
                    <Button size='mini' icon={<Target size={13} />} onClick={() => void focusPane(pane)} />
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Send-prompt modal */}
      <Modal
        title={promptPane ? `${t('settings.herdr.promptTo', { defaultValue: 'Prompt' })} ${promptPane.agent ?? promptPane.paneId}` : ''}
        visible={!!promptPane}
        onCancel={() => setPromptPane(null)}
        onOk={() => void doSendPrompt()}
        confirmLoading={sending}
        okText={t('settings.herdr.send', { defaultValue: 'Send' })}
        okButtonProps={{ disabled: !promptText.trim() }}
        autoFocus={false}
        style={{ width: 600 }}
      >
        <Input.TextArea
          placeholder={t('settings.herdr.promptPlaceholder', { defaultValue: 'Type a prompt to send to this agent…' })}
          value={promptText}
          onChange={setPromptText}
          autoSize={{ minRows: 3, maxRows: 10 }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void doSendPrompt();
          }}
        />
        <div style={{ marginTop: 8 }}>
          <Checkbox checked={submitOnSend} onChange={setSubmitOnSend}>
            {t('settings.herdr.submitOnSend', { defaultValue: 'Press Enter after sending (submit)' })}
          </Checkbox>
        </div>
      </Modal>

      {/* Output modal */}
      <Modal
        title={outputPane ? `${t('settings.herdr.outputOf', { defaultValue: 'Output' })} · ${outputPane.agent ?? outputPane.paneId}` : ''}
        visible={!!outputPane}
        onCancel={() => setOutputPane(null)}
        footer={
          <Button onClick={() => outputPane && void openOutput(outputPane)} loading={loadingOutput}>
            {t('common.refresh', { defaultValue: 'Refresh' })}
          </Button>
        }
        style={{ width: 720 }}
      >
        {loadingOutput ? (
          <Typography.Text type='secondary'>{t('common.loading', { defaultValue: 'Loading…' })}</Typography.Text>
        ) : (
          <pre
            style={{
              maxHeight: 420,
              overflow: 'auto',
              background: 'var(--bg-1)',
              border: '1px solid var(--bg-3)',
              borderRadius: 6,
              padding: 10,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              margin: 0,
            }}
          >
            {outputText || t('settings.herdr.noOutput', { defaultValue: '(no output)' })}
          </pre>
        )}
      </Modal>

      {/* New-agent modal */}
      <Modal
        title={t('settings.herdr.newAgent', { defaultValue: 'New agent' })}
        visible={agentOpen}
        onCancel={() => setAgentOpen(false)}
        onOk={() => void doStartAgent()}
        confirmLoading={startingAgent}
        autoFocus={false}
        style={{ width: 520 }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Input
            addBefore={t('settings.herdr.command', { defaultValue: 'Command' })}
            placeholder='claude'
            value={agentCmd}
            onChange={setAgentCmd}
          />
          <Input
            addBefore={t('settings.herdr.cwd', { defaultValue: 'Directory' })}
            placeholder={t('settings.herdr.cwdPlaceholder', { defaultValue: 'Working directory (optional)' })}
            value={agentCwd}
            onChange={setAgentCwd}
          />
          <Select
            placeholder={t('settings.herdr.workspace', { defaultValue: 'Workspace (optional)' })}
            value={agentWorkspace}
            onChange={(v) => setAgentWorkspace(v)}
            allowClear
          >
            {view.workspaces.map((ws) => (
              <Select.Option key={ws.workspaceId} value={ws.workspaceId}>
                {ws.label}
              </Select.Option>
            ))}
          </Select>
          <Typography.Text type='secondary' style={{ fontSize: 12 }}>
            {t('settings.herdr.newAgentNote', {
              defaultValue: 'Spawns the command as a herdr agent (e.g. "claude", "codex"). Leave the workspace blank to open a new one.',
            })}
          </Typography.Text>
        </div>
      </Modal>
    </div>
  );
};

export default HerdrSettings;
