import React from 'react';
import type { CatalogIndexEntry } from '../types';
import type { UIStatus } from '../status';
import { McpCard } from './McpCard';

interface Props {
  entries: CatalogIndexEntry[];
  installedIds: Set<string>;
  statusByLibraryId?: Record<string, UIStatus>;
  onSelect: (id: string) => void;
}

export function RecommendedGrid({ entries, installedIds, statusByLibraryId, onSelect }: Props) {
  return (
    <section className="mcp-rec-section">
      <h3 className="mcp-rec-title">★ Recommended for you</h3>
      <div className="mcp-rec-grid">
        {entries.map((e) => (
          <McpCard
            key={e.id}
            entry={e}
            installed={installedIds.has(e.id)}
            status={statusByLibraryId?.[e.id]}
            onClick={() => onSelect(e.id)}
          />
        ))}
      </div>
    </section>
  );
}
