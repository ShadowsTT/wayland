/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Zap,
  PenLine,
  Handshake,
  Rocket,
  BarChart3,
  Landmark,
  type LucideIcon,
} from 'lucide-react';
import type { QuickLaunchAnchorId } from '@/renderer/pages/guid/quickLaunchAnchors';
import styles from './QuickLaunchCard.module.css';

/**
 * Single quick-launch card. Renders a Lucide glyph + label + sub-line.
 * The icon name is looked up in ICON_MAP (kebab-case keys matching
 * QuickLaunchAnchor.lucideIcon); unknown names fall back to Zap so the
 * card always renders something. Cowork variant gets a subtle orange
 * tint via the `cowork` class to mark it as the place-anchor button.
 */

const ICON_MAP: Record<string, LucideIcon> = {
  'zap': Zap,
  'pen-line': PenLine,
  'handshake': Handshake,
  'rocket': Rocket,
  'bar-chart-3': BarChart3,
  'landmark': Landmark,
};

export type QuickLaunchCardProps = {
  id: QuickLaunchAnchorId;
  label: string;
  sub: string;
  lucideIcon: string;
  isCowork?: boolean;
  onSelect: (id: QuickLaunchAnchorId) => void;
};

const QuickLaunchCard: React.FC<QuickLaunchCardProps> = ({
  id,
  label,
  sub,
  lucideIcon,
  isCowork = false,
  onSelect,
}) => {
  const IconComponent = ICON_MAP[lucideIcon] ?? Zap;
  return (
    <button
      type='button'
      data-quicklaunch-id={id}
      className={`${styles.card} ${isCowork ? styles.cowork : ''}`}
      onClick={() => onSelect(id)}
      aria-label={`${label} — ${sub}`}
    >
      <div className={styles.icon}>
        <IconComponent size={18} />
      </div>
      <div className={styles.label}>{label}</div>
      <div className={styles.sub}>{sub}</div>
    </button>
  );
};

export default QuickLaunchCard;
