import React, { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Message } from '@arco-design/web-react';
import { useMcpLibrary } from './hooks/useMcpLibrary';
import {
  useMcpServers,
  useMcpAgentStatus,
  useMcpOperations,
  useMcpServerCRUD,
  useMcpOAuth,
} from '@renderer/hooks/mcp';
import type { IMcpServer } from '@/common/config/storage';
import AddMcpServerModal from '@renderer/pages/settings/components/AddMcpServerModal';
import { RecommendedGrid } from './components/RecommendedGrid';
import { CategorySection } from './components/CategorySection';
import { McpLibraryTabs } from './components/McpLibraryTabs';
import { McpCardActionsProvider, type McpCardActions } from './components/McpCardActions';
import { deriveStatus, needsAttention, type UIStatus } from './status';
import type { CatalogIndexEntry } from './types';
import { Modal } from '@arco-design/web-react';

type Availability = 'all' | 'installed' | 'available' | 'attention';

export function BrowsePage() {
  const { t } = useTranslation();
  const library = useMcpLibrary();
  const { mcpServers, saveMcpServers } = useMcpServers();
  const navigate = useNavigate();

  const [message, contextHolder] = Message.useMessage();
  const [showAddModal, setShowAddModal] = useState(false);
  const { setAgentInstallStatus, checkSingleServerInstallStatus } = useMcpAgentStatus();
  const { syncMcpToAgents, removeMcpFromAgents } = useMcpOperations(mcpServers, message);
  const { oauthStatus } = useMcpOAuth();
  const crud = useMcpServerCRUD(
    mcpServers,
    saveMcpServers,
    syncMcpToAgents,
    removeMcpFromAgents,
    checkSingleServerInstallStatus,
    setAgentInstallStatus
  );

  const handleAddSubmit = useCallback(
    (serverData: Omit<IMcpServer, 'id' | 'createdAt' | 'updatedAt'>) => {
      void crud.handleAddMcpServer(serverData);
    },
    [crud]
  );

  const handleAddBatch = useCallback(
    (servers: Omit<IMcpServer, 'id' | 'createdAt' | 'updatedAt'>[]) => {
      void crud.handleBatchImportMcpServers(servers);
    },
    [crud]
  );

  const installedIds = useMemo(
    () => new Set(mcpServers.map((s) => s.libraryEntryId).filter(Boolean) as string[]),
    [mcpServers],
  );

  // Health of each installed catalog entry, keyed by its catalog id, so a broken
  // or sign-in-needed connector is flagged right on its Browse card.
  const statusByLibraryId = useMemo(() => {
    const map: Record<string, UIStatus> = {};
    for (const s of mcpServers) {
      if (s.libraryEntryId) map[s.libraryEntryId] = deriveStatus(s, oauthStatus[s.id]);
    }
    return map;
  }, [mcpServers, oauthStatus]);

  const [avail, setAvail] = useState<Availability>('all');
  const [search, setSearch] = useState('');

  const matchesAvail = useCallback(
    (id: string) => {
      const installed = installedIds.has(id);
      switch (avail) {
        case 'installed':
          return installed;
        case 'available':
          return !installed;
        case 'attention': {
          const st = statusByLibraryId[id];
          return installed && st !== undefined && needsAttention(st);
        }
        default:
          return true;
      }
    },
    [avail, installedIds, statusByLibraryId],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return library.entries.filter(
      (e) =>
        matchesAvail(e.id) &&
        (q === '' ||
          e.name.toLowerCase().includes(q) ||
          e.shortDescription.toLowerCase().includes(q)),
    );
  }, [library.entries, search, matchesAvail]);

  const availCounts = useMemo(() => {
    let installed = 0;
    let attention = 0;
    for (const e of library.entries) {
      if (installedIds.has(e.id)) {
        installed++;
        const st = statusByLibraryId[e.id];
        if (st !== undefined && needsAttention(st)) attention++;
      }
    }
    return {
      all: library.entries.length,
      installed,
      available: library.entries.length - installed,
      attention,
    };
  }, [library.entries, installedIds, statusByLibraryId]);

  const categoryOrder = [
    'communication',
    'files-and-docs',
    'calendar',
    'developer',
    'code',
    'productivity',
    'search',
    'automation',
    'browser',
    'crm',
    'data',
    'devops',
    'home-automation',
    'infrastructure',
    'iot',
    'knowledge',
    'media',
    'news',
    'observability',
    'payments',
    'research',
    'sales',
    'tasks',
    'personal',
  ];

  const filteredByCategory = useMemo(() => {
    const map: Record<string, CatalogIndexEntry[]> = {};
    for (const e of filtered) {
      const primary = e.categories[0] ?? 'personal';
      (map[primary] ??= []).push(e);
    }
    return map;
  }, [filtered]);

  // Render the curated category order first, then ANY remaining categories
  // present in the data but missing from the curated list - so a new catalog
  // category (design / database / ml / ...) can never make its entries
  // invisible on Browse. Discoverability is non-negotiable: every catalog
  // entry must be reachable by browsing, not just by name search.
  const renderCategories = useMemo(() => {
    const extra = Object.keys(filteredByCategory)
      .filter((c) => !categoryOrder.includes(c))
      .toSorted();
    return [...categoryOrder, ...extra];
    // categoryOrder is a module-stable literal; safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredByCategory]);

  const onSelect = (id: string) =>
    navigate(`/settings/mcp-library/${encodeURIComponent(id)}`);

  // Installed server per catalog id, so a card can offer its quick on/off
  // toggle + right-click lifecycle menu.
  const serverByLibraryId = useMemo(() => {
    const map = new Map<string, IMcpServer>();
    for (const s of mcpServers) {
      if (s.libraryEntryId) map.set(s.libraryEntryId, s);
    }
    return map;
  }, [mcpServers]);

  const cardActions = useMemo<McpCardActions>(
    () => ({
      serverFor: (libraryEntryId) => serverByLibraryId.get(libraryEntryId),
      onToggle: (serverId, enabled) => void crud.handleToggleMcpServer(serverId, enabled),
      onConfigure: onSelect,
      onRemove: (serverId) => {
        const target = mcpServers.find((s) => s.id === serverId);
        Modal.confirm({
          title: t('mcpLibrary.card.removeTitle', 'Remove connector?'),
          content: t('mcpLibrary.card.removeBody', 'This removes {{name}} and its config from your agents. You can re-add it any time.', {
            name: target?.name ?? 'this connector',
          }),
          okButtonProps: { status: 'danger' },
          okText: t('mcpLibrary.card.remove', 'Remove'),
          onOk: () => void crud.handleDeleteMcpServer(serverId),
        });
      },
    }),
    // onSelect is a stable navigate wrapper; crud/mcpServers/t cover the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverByLibraryId, crud, mcpServers, t],
  );

  return (
    <div className="mcp-library-page">
      {contextHolder}
      <header className="mcp-page-head">
        <div>
          <h2>MCP Library</h2>
          <p>
            Curated connectors. Browse, install with one click, and follow the setup guide.
          </p>
        </div>
        <button className="mcp-btn-primary" onClick={() => setShowAddModal(true)}>
          {t('mcpLibrary.installed.addCustom', '+ Add MCP')}
        </button>
      </header>

      <McpLibraryTabs active="browse" installedCount={mcpServers.length} />

      <div className="mcp-filter-bar">
        <input
          className="mcp-search"
          placeholder={t('mcpLibrary.browse.searchPlaceholder', 'Search MCPs…')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="mcp-avail-filter">
          {(
            [
              { key: 'all', label: t('mcpLibrary.browse.availAll', 'All') },
              { key: 'installed', label: t('mcpLibrary.browse.availInstalled', 'Installed') },
              { key: 'attention', label: t('mcpLibrary.browse.availAttention', 'Needs attention') },
            ] as { key: Availability; label: string }[]
          ).map((opt) => {
            const count = availCounts[opt.key];
            // Hide the attention chip entirely when nothing needs attention and
            // it isn't the active filter - no point showing "Needs attention 0".
            if (opt.key === 'attention' && count === 0 && avail !== 'attention') return null;
            const active = avail === opt.key;
            return (
              <button
                key={opt.key}
                className={`mcp-chip ${active ? 'is-active' : ''} ${opt.key === 'attention' && count > 0 ? 'mcp-chip-attention' : ''}`}
                aria-pressed={active}
                onClick={() => setAvail(opt.key)}
              >
                {opt.label} <span className="mcp-chip-count">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <McpCardActionsProvider value={cardActions}>
        {search === '' && avail === 'all' && (
          <RecommendedGrid
            entries={library.recommended}
            installedIds={installedIds}
            statusByLibraryId={statusByLibraryId}
            onSelect={onSelect}
          />
        )}

        {filtered.length === 0 ? (
          <div className="mcp-empty">
            {t('mcpLibrary.browse.emptyFilter', 'No connectors match your search and filters.')}
          </div>
        ) : (
          renderCategories.map((cat) => (
            <CategorySection
              key={cat}
              category={cat}
              entries={filteredByCategory[cat] ?? []}
              installedIds={installedIds}
              statusByLibraryId={statusByLibraryId}
              onSelect={onSelect}
            />
          ))
        )}
      </McpCardActionsProvider>

      <AddMcpServerModal
        visible={showAddModal}
        onCancel={() => setShowAddModal(false)}
        onSubmit={handleAddSubmit}
        onBatchImport={handleAddBatch}
      />
    </div>
  );
}
