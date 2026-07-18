/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Process-wide subscription usage poller. Mirrors cronServiceSingleton: one
 * shared instance the bridge wires to the renderer.
 */

import { UsagePoller } from './UsagePoller';

export const subscriptionUsagePoller = new UsagePoller();
