import React from 'react';
import { useTranslation } from 'react-i18next';
import { Dropdown, Menu, Switch } from '@arco-design/web-react';
import { Check, Plus, AlertTriangle, LogIn } from 'lucide-react';
import type { CatalogIndexEntry } from '../types';
import type { UIStatus } from '../status';
import { needsAttention } from '../status';
import { TierBadge } from './TierBadge';
import { MaintainerBadge } from './MaintainerBadge';
import { useMcpCardActions } from './McpCardActions';

interface Props {
  entry: CatalogIndexEntry;
  installed: boolean;
  /** Health of the installed server for this entry, when one exists. */
  status?: UIStatus;
  onClick: () => void;
}

export function McpCard({ entry, installed, status, onClick }: Props) {
  const { t } = useTranslation();
  const actions = useMcpCardActions();
  const server = installed ? actions?.serverFor(entry.id) : undefined;
  const isWaylandBuilt = entry.maintainerType === 'wayland';
  // An installed connector that is broken or wants a sign-in is surfaced right
  // on the card so the user can spot it at a glance instead of hunting Installed.
  const attention = installed && status !== undefined && needsAttention(status);

  // Right-click menu: quick lifecycle actions without opening the detail page.
  const contextMenu = (
    <Menu
      onClickMenuItem={(key) => {
        if (!actions) return;
        if (key === 'toggle' && server) actions.onToggle(server.id, !server.enabled);
        else if (key === 'configure') actions.onConfigure(entry.id);
        else if (key === 'remove' && server) actions.onRemove(server.id);
        else if (key === 'install') actions.onConfigure(entry.id);
      }}
    >
      {server ? (
        [
          <Menu.Item key="toggle">
            {server.enabled
              ? t('mcpLibrary.card.disable', 'Disable')
              : t('mcpLibrary.card.enable', 'Enable')}
          </Menu.Item>,
          <Menu.Item key="configure">{t('mcpLibrary.card.configure', 'Configure')}</Menu.Item>,
          <Menu.Item key="remove">{t('mcpLibrary.card.remove', 'Remove')}</Menu.Item>,
        ]
      ) : (
        <Menu.Item key="install">{t('mcpLibrary.browse.cardInstall', 'Install')}</Menu.Item>
      )}
    </Menu>
  );

  const card = (
    <div
      className={`mcp-card ${installed ? 'is-installed' : ''} ${attention ? `is-attention status-${status}` : ''} ${isWaylandBuilt ? 'is-wayland-built' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {server && (
        // Quick on/off right on the card. Stop propagation so flipping the
        // switch never opens the detail page underneath it.
        <span
          className="mcp-card-toggle"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Switch
            size="small"
            checked={server.enabled}
            onChange={(v) => actions?.onToggle(server.id, v)}
            aria-label={t('mcpLibrary.card.toggleAria', 'Enable or disable {{name}}', { name: entry.name })}
          />
        </span>
      )}
      <div className="mcp-card-top">
        <img className="mcp-card-logo" src={entry.iconUrl} alt="" />
        <div className="mcp-card-meta">
          <div className="mcp-card-name">
            {entry.name}
            {entry.verifiedByWayland && (
              <Check className="mcp-card-verified-tick" size={13} />
            )}
          </div>
          <div className="mcp-card-publisher">{entry.id}</div>
        </div>
      </div>
      <div className="mcp-card-desc">{entry.shortDescription}</div>
      <div className="mcp-card-tags">
        <TierBadge tier={entry.tier} />
        <MaintainerBadge type={entry.maintainerType} />
      </div>
      <div className="mcp-card-footer">
        <button
          className={`mcp-install-btn ${installed ? 'is-installed' : ''} ${attention ? `is-attention status-${status}` : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
        >
          {attention ? (
            status === 'warn' ? (
              <>
                <LogIn size={12} /> {t('mcpLibrary.browse.cardSignIn', 'Sign in')}
              </>
            ) : (
              <>
                <AlertTriangle size={12} /> {t('mcpLibrary.browse.cardFix', 'Needs attention')}
              </>
            )
          ) : installed ? (
            <>
              <Check size={12} /> {t('mcpLibrary.browse.cardInstalled', 'Installed')}
            </>
          ) : (
            <>
              <Plus size={12} /> {t('mcpLibrary.browse.cardInstall', 'Install')}
            </>
          )}
        </button>
      </div>
    </div>
  );

  // No actions context (e.g. a surface that doesn't wire lifecycle) - render the
  // bare card so the component still works standalone.
  if (!actions) return card;

  return (
    <Dropdown droplist={contextMenu} trigger="contextMenu" position="bl">
      {card}
    </Dropdown>
  );
}
