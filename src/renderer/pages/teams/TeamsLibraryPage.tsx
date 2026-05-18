/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TeamsLibraryPage — /teams route. Renders the 24 vendored launchers
 * (kind === 'team') split into Standing Companies (5, _standing === true)
 * and ad-hoc Teams (19). Mirrors AssistantsLibraryPage's launch flow:
 * clicking a team card navigates to /teams/<id>/launch (the launcher
 * screen W2b will fill in). Clicking Build my own → /teams/new.
 *
 * Source of truth for the team list: useAssistantList() (same hook
 * /assistants uses). We filter to kind === 'team' here; /assistants
 * filters the opposite direction (see AssistantsLibraryPage T2a.4).
 */

import { Button } from '@arco-design/web-react';
import { Plus } from 'lucide-react';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAssistantList } from '@/renderer/hooks/assistant';
import type { AssistantListItem } from '@/renderer/pages/settings/AssistantSettings/types';
import BuildMyOwnTeamCard from './components/BuildMyOwnTeamCard';
import TeamCard from './components/TeamCard';
import styles from './TeamsLibraryPage.module.css';

const TeamsLibraryPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { assistants, localeKey } = useAssistantList();

  const { standing, teams } = useMemo(() => {
    const standingList: AssistantListItem[] = [];
    const teamsList: AssistantListItem[] = [];
    for (const assistant of assistants) {
      if (assistant._kind !== 'team') continue;
      if (assistant._standing === true) standingList.push(assistant);
      else teamsList.push(assistant);
    }
    return { standing: standingList, teams: teamsList };
  }, [assistants]);

  const totalTeams = standing.length + teams.length;

  const handleLaunchTeam = useCallback(
    (team: AssistantListItem) => {
      void Promise.resolve(navigate(`/teams/${team.id}/launch`)).catch((error) => {
        console.error('Navigation to team launcher failed:', error);
      });
    },
    [navigate]
  );

  const handleBuildMyOwn = useCallback(() => {
    void Promise.resolve(navigate('/teams/new')).catch((error) => {
      console.error('Navigation to team builder failed:', error);
    });
  }, [navigate]);

  return (
    <div className={styles.page} data-testid='teams-library-page'>
      <div className={styles.actionBar} data-testid='teams-action-bar'>
        <div className={styles.actionBarTitleGroup}>
          <h1 className={styles.actionBarTitle}>{t('teams.title', { defaultValue: 'Teams' })}</h1>
          <span className={styles.actionBarSubtitle} data-testid='teams-total-count'>
            {t('teams.totalCount', {
              count: totalTeams,
              defaultValue: '{{count}} teams',
            })}
          </span>
        </div>
        <Button
          type='primary'
          icon={<Plus size={14} />}
          onClick={handleBuildMyOwn}
          data-testid='teams-build-my-own-cta'
        >
          {t('teams.buildMyOwn.cta', { defaultValue: 'Build my own team' })}
        </Button>
      </div>

      <div className={styles.scroll}>
        {totalTeams === 0 && (
          <div className={styles.emptyState} data-testid='teams-empty-state'>
            {t('teams.emptyState', { defaultValue: 'No teams available yet.' })}
          </div>
        )}

        {standing.length > 0 && (
          <section className={styles.sectionGroup} data-testid='teams-group-standing'>
            <header className={styles.sectionHeader}>
              <span className={`${styles.sectionTitle} ${styles.sectionTitleStanding}`}>
                {t('teams.group.standing', { defaultValue: 'Standing Companies' })}
              </span>
              <span className={styles.sectionHint}>
                {t('teams.group.standingHint', {
                  count: standing.length,
                  defaultValue: '{{count}} — persistent, ritualized orgs that run continuously',
                })}
              </span>
            </header>
            <div className={styles.gridStanding}>
              {standing.map((team) => (
                <TeamCard key={team.id} team={team} localeKey={localeKey} onLaunch={handleLaunchTeam} />
              ))}
            </div>
          </section>
        )}

        {(teams.length > 0 || standing.length > 0) && (
          <section className={styles.sectionGroup} data-testid='teams-group-teams'>
            <header className={styles.sectionHeader}>
              <span className={`${styles.sectionTitle} ${styles.sectionTitleTeams}`}>
                {t('teams.group.teams', { defaultValue: 'Teams' })}
              </span>
              <span className={styles.sectionHint}>
                {t('teams.group.teamsHint', {
                  count: teams.length,
                  defaultValue: '{{count}} — ad-hoc squads for a specific outcome. Spawn, ship, dissolve.',
                })}
              </span>
            </header>
            <div className={styles.gridTeams}>
              {teams.map((team) => (
                <TeamCard key={team.id} team={team} localeKey={localeKey} onLaunch={handleLaunchTeam} />
              ))}
              <BuildMyOwnTeamCard onClick={handleBuildMyOwn} />
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

export default TeamsLibraryPage;
