/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Mission Control usage tab: one card per subscription provider (Claude Code,
 * Codex CLI), each with labelled 5-hour + weekly progress bars, the used %, and
 * a reset countdown. Providers with no local data render a subtle "sign in / run
 * the CLI" hint rather than an error. Reuses the cost tab's BudgetBar.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@arco-design/web-react';
import { RefreshCw, Sparkles, Terminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ProviderUsage, SubscriptionProvider, UsageWindow } from '@process/services/subscriptionUsage/types';
import { BudgetBar } from '../cost/BudgetBar';
import { formatResetCountdown, severityForPercent } from './usageChart';
import { useUsage } from './useUsage';
import styles from './Usage.module.css';

const PROVIDER_ORDER: SubscriptionProvider[] = ['claude', 'codex'];

const PROVIDER_ICON: Record<SubscriptionProvider, LucideIcon> = {
  claude: Sparkles,
  codex: Terminal,
};

const WindowBar: React.FC<{ label: string; window: UsageWindow }> = ({ label, window }) => {
  const { t } = useTranslation();
  const countdown = formatResetCountdown(window.resetsAt);
  return (
    <div className={styles.barRow}>
      <div className={styles.barTop}>
        <span className={styles.barLabel}>{label}</span>
        <span className={styles.barVal}>{Math.round(window.usedPercent)}%</span>
      </div>
      <BudgetBar fraction={window.usedPercent / 100} severity={severityForPercent(window.usedPercent)} />
      {countdown ? (
        <span className={styles.reset}>{t('missionControl.usage.resetsIn', { time: countdown })}</span>
      ) : null}
    </div>
  );
};

const ProviderCard: React.FC<{ provider: SubscriptionProvider; usage: ProviderUsage | undefined }> = ({
  provider,
  usage,
}) => {
  const { t } = useTranslation();
  const Icon = PROVIDER_ICON[provider];
  const name = t(`missionControl.usage.provider.${provider}`);

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardIcon}>
          <Icon size={16} />
        </span>
        <span className={styles.cardName}>{name}</span>
      </div>

      {!usage || !usage.available ? (
        <span className={styles.unavailable}>{t(`missionControl.usage.unavailable.${provider}`)}</span>
      ) : (
        <div className={styles.bars}>
          {usage.fiveHour ? (
            <WindowBar label={t('missionControl.usage.window.fiveHour')} window={usage.fiveHour} />
          ) : null}
          {usage.weekly ? <WindowBar label={t('missionControl.usage.window.weekly')} window={usage.weekly} /> : null}
          {usage.weeklySonnet ? (
            <WindowBar label={t('missionControl.usage.window.weeklySonnet')} window={usage.weeklySonnet} />
          ) : null}
        </div>
      )}
    </div>
  );
};

export const UsageTab: React.FC = () => {
  const { t } = useTranslation();
  const { snapshot, loading, refresh } = useUsage();
  const byProvider = new Map(snapshot.providers.map((p) => [p.provider, p]));

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <span className={styles.toolbarTitle}>{t('missionControl.usage.title')}</span>
        <Button size='small' icon={<RefreshCw size={14} />} loading={loading} onClick={() => void refresh()}>
          {t('missionControl.refresh')}
        </Button>
      </div>

      <div className={styles.cards}>
        {PROVIDER_ORDER.map((provider) => (
          <ProviderCard key={provider} provider={provider} usage={byProvider.get(provider)} />
        ))}
      </div>
    </div>
  );
};

export default UsageTab;
