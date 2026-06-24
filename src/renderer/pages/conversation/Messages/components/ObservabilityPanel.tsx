/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageActivity, TMessage } from '@/common/chat/chatLib';
import { useObservabilitySettings } from '@/renderer/hooks/settings/useObservabilitySettings';
import { Button, Switch } from '@arco-design/web-react';
import { Close } from '@icon-park/react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMessageList } from '../hooks';
import MessageActivity from './MessageActivity';
import styles from './ObservabilityPanel.module.css';

/**
 * #252 reframe - opt-in right-side observability panel.
 *
 * The chat center stays calm (only the inline working pulse remains there); the
 * full activity tree moves here. The panel mounts INSIDE WCoreChat's
 * MessageListProvider subtree so it can read the same message stream via
 * useMessageList, filter the `activity` turns, and render each one through the
 * existing MessageActivity card (reused as-is, not rewritten). Cost is gated by
 * the opt-in `showCost` setting (off by default).
 */

const isActivity = (m: TMessage): m is IMessageActivity => m.type === 'activity';

const ObservabilityPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const { settings, update } = useObservabilitySettings();
  const list = useMessageList();

  const activityMessages = useMemo(() => list.filter(isActivity), [list]);

  return (
    <div className={styles.container} data-testid='observability-panel'>
      <header className={styles.header}>
        <span className={styles.title}>{t('conversation.observability.title', { defaultValue: 'Observability' })}</span>
        <span className={styles.spacer} />
        <Button
          type='text'
          size='mini'
          icon={<Close size='16' />}
          aria-label={t('conversation.observability.close', { defaultValue: 'Close panel' })}
          title={t('conversation.observability.close', { defaultValue: 'Close panel' })}
          onClick={onClose}
        />
      </header>

      <div className={styles.body}>
        {activityMessages.length === 0 ? (
          <div className={styles.empty}>
            {t('conversation.observability.empty', {
              defaultValue: 'Activity from this conversation will appear here.',
            })}
          </div>
        ) : (
          activityMessages.map((m) => <MessageActivity key={m.id} message={m} showCost={settings.showCost} />)
        )}
      </div>

      <footer className={styles.settings}>
        <span className={styles.settingLabel}>
          {t('conversation.observability.showCost', { defaultValue: 'Show cost' })}
        </span>
        <span className={styles.settingHint}>
          {t('conversation.observability.showCostHint', { defaultValue: 'off by default' })}
        </span>
        <span className={styles.spacer} />
        <Switch checked={settings.showCost} onChange={(v) => update('showCost', v)} size='small' />
      </footer>
    </div>
  );
};

export default ObservabilityPanel;
