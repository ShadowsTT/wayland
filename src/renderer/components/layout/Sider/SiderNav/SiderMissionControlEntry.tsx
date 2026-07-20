/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { Gauge } from 'lucide-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@arco-design/web-react';
import classNames from 'classnames';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';
import type { BudgetSeverity } from '@renderer/pages/mission-control/cost/costChart';
import { maxUsagePercent, severityForPercent } from '@renderer/pages/mission-control/usage/usageChart';
import { useUsage } from '@renderer/pages/mission-control/usage/useUsage';

// Compact subscription-usage indicator: a dot colored by the highest current
// utilization across Claude + Codex windows. Rendered only when there is data,
// so it stays non-intrusive (no dot on a fresh / signed-out install).
const SEVERITY_COLOR: Record<BudgetSeverity, string> = {
  ok: '#2ec27e',
  warn: '#ff9f43',
  over: '#ff4d4f',
};

const UsageDot: React.FC<{ percent: number }> = ({ percent }) => (
  <span
    className='w-6px h-6px rd-full shrink-0'
    style={{ backgroundColor: SEVERITY_COLOR[severityForPercent(percent)] }}
  />
);

interface SiderMissionControlEntryProps {
  isMobile: boolean;
  isActive: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onClick: () => void;
}

const SiderMissionControlEntry: React.FC<SiderMissionControlEntryProps> = ({
  isActive,
  collapsed,
  siderTooltipProps,
  onClick,
}) => {
  const { t } = useTranslation();
  const label = t('missionControl.sidebarLabel', { defaultValue: 'Mission Control' });
  const { snapshot } = useUsage();
  const usagePercent = maxUsagePercent(snapshot);
  const hasUsage = usagePercent >= 0;
  const tooltipContent = hasUsage
    ? `${label} · ${t('missionControl.usage.sidebarTooltip', { percent: Math.round(usagePercent) })}`
    : label;

  if (collapsed) {
    return (
      <Tooltip {...siderTooltipProps} content={tooltipContent} position='right'>
        <div
          className={classNames(
            'w-full h-26px flex items-center justify-center cursor-pointer transition-colors rd-8px text-t-primary relative',
            isActive ? 'bg-[rgba(var(--primary-6),0.12)] text-primary' : 'hover:bg-fill-3 active:bg-fill-4'
          )}
          onClick={onClick}
          data-testid='sider-mission-control-entry'
        >
          <Gauge size={16} className='block leading-none shrink-0' style={{ lineHeight: 0 }} />
          {hasUsage ? (
            <span className='absolute top-2px right-2px'>
              <UsageDot percent={usagePercent} />
            </span>
          ) : null}
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip {...siderTooltipProps} content={tooltipContent} position='right'>
      <div
        className={classNames(
          'box-border h-26px w-full flex items-center justify-start gap-8px px-8px rd-0.5rem cursor-pointer shrink-0 transition-all text-t-primary',
          isActive ? 'bg-[rgba(var(--primary-6),0.12)] text-primary' : 'hover:bg-fill-3 active:bg-fill-4'
        )}
        onClick={onClick}
        data-testid='sider-mission-control-entry'
      >
        <span className='w-20px h-20px flex items-center justify-center shrink-0'>
          <Gauge size={16} className='block leading-none' style={{ lineHeight: 0 }} />
        </span>
        <span className='collapsed-hidden text-t-primary text-12px font-medium leading-20px'>{label}</span>
        {hasUsage ? (
          <span className='collapsed-hidden ml-auto flex items-center gap-4px text-t-secondary text-11px font-medium leading-20px tabular-nums'>
            <UsageDot percent={usagePercent} />
            {Math.round(usagePercent)}%
          </span>
        ) : null}
      </div>
    </Tooltip>
  );
};

export default SiderMissionControlEntry;
