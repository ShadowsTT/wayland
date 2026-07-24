/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Input, Message, Switch } from '@arco-design/web-react';
import { Lightning } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { HEADROOM_DEFAULT_ENDPOINT, isValidHeadroomEndpoint } from '@/common/config/headroom';
import styles from './AgentsSettings.module.css';

/**
 * Headroom Proxy card on the Agents settings page. Headroom is a *local,
 * transparent Anthropic-wire proxy*: when enabled, Wayland points the claude
 * agent backend (and its own in-app Anthropic clients) at the local proxy via
 * `ANTHROPIC_BASE_URL`, so requests are compressed + forwarded upstream under
 * the user's OWN credentials (native auth is never swapped).
 *
 *  - A Switch flips `system.routeThroughHeadroom`.
 *  - An editable endpoint field persists `system.headroomEndpoint`
 *    (default http://127.0.0.1:8787).
 *
 * Headroom is MUTUALLY EXCLUSIVE with Flux Router — a single request cannot go
 * through both a hosted gateway and a local proxy. The bridge disables the other
 * flag whenever one is enabled; this card additionally greys out its own toggle
 * while Flux routing is on, so the exclusivity is visible rather than silent.
 */
const HeadroomRouterCard: React.FC = () => {
  const { t } = useTranslation();

  const [routeEnabled, setRouteEnabled] = useState(false);
  const [fluxEnabled, setFluxEnabled] = useState(false);
  const [endpoint, setEndpoint] = useState(HEADROOM_DEFAULT_ENDPOINT);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    ipcBridge.systemSettings.getRouteThroughHeadroom
      .invoke()
      .then(setRouteEnabled)
      .catch((err) => console.warn('[HeadroomRouterCard.getRouteThroughHeadroom]', err));
    ipcBridge.systemSettings.getRouteThroughFlux
      .invoke()
      .then(setFluxEnabled)
      .catch((err) => console.warn('[HeadroomRouterCard.getRouteThroughFlux]', err));
    ipcBridge.systemSettings.getHeadroomEndpoint
      .invoke()
      .then((value) => setEndpoint(value || HEADROOM_DEFAULT_ENDPOINT))
      .catch((err) => console.warn('[HeadroomRouterCard.getHeadroomEndpoint]', err));
  }, []);

  const handleRouteChange = useCallback(async (enabled: boolean) => {
    setSaving(true);
    try {
      await ipcBridge.systemSettings.setRouteThroughHeadroom.invoke({ enabled });
      setRouteEnabled(enabled);
      // Enabling Headroom disables Flux (mutual exclusivity, enforced in the bridge).
      if (enabled) setFluxEnabled(false);
    } catch (err) {
      Message.error(String(err));
    } finally {
      setSaving(false);
    }
  }, []);

  const handleEndpointSave = useCallback(async () => {
    const next = endpoint.trim();
    if (!isValidHeadroomEndpoint(next)) {
      Message.error(t('settings.agentsPage.headroom.endpointInvalid'));
      return;
    }
    try {
      await ipcBridge.systemSettings.setHeadroomEndpoint.invoke({ endpoint: next });
      setEndpoint(next);
    } catch (err) {
      Message.error(String(err));
    }
  }, [endpoint, t]);

  return (
    <div className={styles.flux} data-testid='headroom-router-card'>
      <div className={styles.fluxIcon}>
        <Lightning size={19} theme='outline' fill='currentColor' />
      </div>
      <div className={styles.fluxBody}>
        <div className={styles.fluxTitle}>{t('settings.agentsPage.headroom.title')}</div>
        <div className={styles.fluxToggleRow}>
          <span className={styles.fluxToggleLabel}>{t('settings.agentsPage.headroom.routeToggleLabel')}</span>
          <Switch
            size='small'
            checked={routeEnabled}
            loading={saving}
            disabled={fluxEnabled}
            onChange={handleRouteChange}
            data-testid='headroom-route-toggle'
          />
        </div>
        <div className={styles.fluxDesc}>
          {fluxEnabled
            ? t('settings.agentsPage.headroom.fluxActiveNote')
            : t('settings.agentsPage.headroom.routeToggleHelp')}
        </div>
        <div className={styles.fluxToggleRow}>
          <span className={styles.fluxToggleLabel}>{t('settings.agentsPage.headroom.endpointLabel')}</span>
          <Input
            size='small'
            style={{ maxWidth: 260 }}
            value={endpoint}
            placeholder={HEADROOM_DEFAULT_ENDPOINT}
            onChange={setEndpoint}
            onBlur={() => void handleEndpointSave()}
            onPressEnter={() => void handleEndpointSave()}
            data-testid='headroom-endpoint-input'
          />
        </div>
      </div>
    </div>
  );
};

export default HeadroomRouterCard;
