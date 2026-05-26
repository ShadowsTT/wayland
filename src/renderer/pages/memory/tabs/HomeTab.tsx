/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wave 5 — HomeTab is the landing tab of FullPanelShell. Three stacked
 * sections, each backed by an MCP verb via `useIjfwBrain` and rendered
 * through `MCPVerbCard` for uniform loading/error/empty UX:
 *
 *   1. Wiki entries (verb `wiki.get`) — clickable rows that switch the
 *      FullPanelShell tab to `wiki` and pin the slug in the URL.
 *   2. Links (verb `links`) — recent (from → type → to) relationships as
 *      compact badges.
 *   3. Ready-to-promote candidates (verb `memory_facts` with
 *      `promotable: true`) — preview + Promote button that calls
 *      `wiki.promote` and refreshes on success.
 */

import { Button, Message } from '@arco-design/web-react';
import { ArrowRight, Link as LinkIcon, Sparkle, Star } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { ipcBridge } from '@/common';
import { MCPVerbCard } from '@renderer/pages/memory/components/MCPVerbCard';
import { useIjfwBrain, type VerbState } from '@renderer/pages/memory/hooks/useIjfwBrain';
import styles from './HomeTab.module.css';

/**
 * Map an `ok:true` payload to a different shape while preserving
 * loading/error states. Used so MCPVerbCard's built-in empty-array check
 * sees the inner list, not the wrapping envelope.
 */
const projectVerbState = <T, U>(state: VerbState<T>, fn: (data: T) => U): VerbState<U> => {
  if (state.loading === true) return state;
  if (state.ok === false) return state;
  return { loading: false, ok: true, data: fn(state.data) };
};

type WikiEntry = { slug: string; title: string };
type WikiPayload = { entries: WikiEntry[] };

type LinkEntry = { from: string; to: string; type: string };
type LinksPayload = { links: LinkEntry[] };

type Candidate = { id: string; preview: string };
type CandidatesPayload = { candidates: Candidate[] };

type EmptyProps = { text: string };
const EmptyState: React.FC<EmptyProps> = ({ text }) => <div className={styles.empty}>{text}</div>;

type WikiListProps = {
  entries: WikiEntry[];
  onSelect: (slug: string) => void;
};
const WikiList: React.FC<WikiListProps> = ({ entries, onSelect }) => (
  <div className={styles.wikiList} data-testid='memory-home-wiki-list'>
    {entries.map((entry) => (
      <Button
        key={entry.slug}
        type='text'
        className={styles.wikiRow}
        onClick={() => onSelect(entry.slug)}
        data-testid={`memory-home-wiki-row-${entry.slug}`}
      >
        <span>{entry.title}</span>
        <ArrowRight size={14} aria-hidden />
      </Button>
    ))}
  </div>
);

type LinkBadgesProps = { links: LinkEntry[] };
const LinkBadges: React.FC<LinkBadgesProps> = ({ links }) => (
  <div className={styles.linkBadges} data-testid='memory-home-links'>
    {links.map((link, idx) => (
      <span
        key={`${link.from}-${link.type}-${link.to}-${idx}`}
        className={styles.linkBadge}
        data-testid='memory-home-link-badge'
      >
        <LinkIcon size={12} aria-hidden />
        {link.from} {link.type} {link.to}
      </span>
    ))}
  </div>
);

type CandidateListProps = {
  candidates: Candidate[];
  onPromote: (id: string) => void;
  pendingId: string | null;
  promoteLabel: string;
};
const CandidateList: React.FC<CandidateListProps> = ({ candidates, onPromote, pendingId, promoteLabel }) => (
  <div className={styles.candidateList} data-testid='memory-home-candidates'>
    {candidates.map((candidate) => (
      <div key={candidate.id} className={styles.candidateRow} data-testid={`memory-home-candidate-${candidate.id}`}>
        <span className={styles.candidatePreview}>{candidate.preview}</span>
        <Button
          type='primary'
          size='mini'
          icon={<Star size={12} aria-hidden />}
          loading={pendingId === candidate.id}
          onClick={() => onPromote(candidate.id)}
          data-testid={`memory-home-promote-${candidate.id}`}
        >
          {promoteLabel}
        </Button>
      </div>
    ))}
  </div>
);

const HomeTab: React.FC = () => {
  const { t } = useTranslation();
  const [, setSearchParams] = useSearchParams();

  // Bumped after a successful promote to force candidates to refetch.
  const [candidatesNonce, setCandidatesNonce] = useState(0);
  const [pendingPromoteId, setPendingPromoteId] = useState<string | null>(null);

  const wikiState = useIjfwBrain<WikiPayload>('wiki.get', {}, []);
  const linksState = useIjfwBrain<LinksPayload>('links', {}, []);
  const candidatesState = useIjfwBrain<CandidatesPayload>('memory_facts', { promotable: true }, [candidatesNonce]);

  // `MCPVerbCard.isDataEmpty` only short-circuits when the top-level data is
  // an empty array / object / string. Each verb here wraps its list in an
  // envelope (`{ entries }`, `{ links }`, `{ candidates }`) which is never
  // an empty object, so we project to the inner list before handing it off.
  const wikiList = projectVerbState(wikiState, (d) => d.entries);
  const linksList = projectVerbState(linksState, (d) => d.links);
  const candidatesList = projectVerbState(candidatesState, (d) => d.candidates);

  const handleWikiSelect = useCallback(
    (slug: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('tab', 'wiki');
          next.set('slug', slug);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const handlePromote = useCallback(
    async (id: string) => {
      setPendingPromoteId(id);
      try {
        const result = await ipcBridge.ijfw.brainInvoke.invoke({
          verb: 'wiki.promote',
          args: { id },
        });
        if (result.ok === true) {
          Message.success(t('memory.home.promote_success'));
          setCandidatesNonce((n) => n + 1);
        } else {
          const reason = result.errorReason ?? 'unknown';
          Message.error(t(`memory.error.${reason}`, { defaultValue: t('memory.error.unknown') }));
        }
      } catch {
        Message.error(t('memory.error.unknown'));
      } finally {
        setPendingPromoteId(null);
      }
    },
    [t]
  );

  return (
    <div className={styles.root} data-testid='memory-tab-home'>
      <section className={styles.section}>
        <h3 className={styles.sectionHeader}>
          <Sparkle size={14} aria-hidden />
          {t('memory.home.wiki_title')}
        </h3>
        <MCPVerbCard
          state={wikiList}
          empty={<EmptyState text={t('memory.home.wiki_empty')} />}
          render={(entries) => <WikiList entries={entries} onSelect={handleWikiSelect} />}
        />
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionHeader}>
          <LinkIcon size={14} aria-hidden />
          {t('memory.home.links_title')}
        </h3>
        <MCPVerbCard
          state={linksList}
          empty={<EmptyState text={t('memory.home.links_empty')} />}
          render={(links) => <LinkBadges links={links} />}
        />
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionHeader}>
          <Star size={14} aria-hidden />
          {t('memory.home.promote_title')}
        </h3>
        <MCPVerbCard
          state={candidatesList}
          empty={<EmptyState text={t('memory.home.promote_empty')} />}
          render={(candidates) => (
            <CandidateList
              candidates={candidates}
              onPromote={handlePromote}
              pendingId={pendingPromoteId}
              promoteLabel={t('memory.home.promote_button')}
            />
          )}
        />
      </section>
    </div>
  );
};

export default HomeTab;
