/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

export { HerdrService, getHerdrService } from './HerdrService';
export { HerdrClient, HerdrEventStream } from './HerdrClient';
export {
  createLineReader,
  encodeRequest,
  resolveHerdrSocketPath,
  HERDR_MONITOR_SUBSCRIPTIONS,
} from './protocol';
export type {
  HerdrActionResult,
  HerdrAgentSession,
  HerdrAgentStatus,
  HerdrPane,
  HerdrReadResult,
  HerdrView,
  HerdrWorkspace,
} from './types';
