/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Standing-Company ritual scheduler. Translates launcher-declared rituals
 * (e.g. `{ name: 'weekly-checkin', cadence: 'weekly:monday:08:00' }`) into
 * persistent cron jobs that wake the team leader at the declared time so
 * the team actually behaves as a standing company instead of a display-only
 * badge.
 *
 * Wiring: instantiated in `initBridge.ts` and injected into
 * `TeamSessionService` via its optional 4th constructor parameter. Absent
 * scheduler = ritual installation is a no-op (test environments).
 */

import { logger } from '@office-ai/platform';
import type { AgentBackend } from '@/common/types/acpTypes';
import { ExtensionRegistry } from '@process/extensions/ExtensionRegistry';
import type { CronService } from '@process/services/cron/CronService';
import type { CronSchedule } from '@process/services/cron/CronStore';
import type { TTeam } from './types';

export type RitualsResolver = (
  sourceLauncherId: string
) => Promise<Array<{ name: string; cadence: string }> | undefined>;

/**
 * Live RitualsResolver backed by the ExtensionRegistry. Walks the assistant
 * list and returns the `rituals` array for the requested source launcher.
 * Used by both the team-import/export bridge and the standing-ritual
 * scheduler so both paths agree on a single source of truth.
 */
export function makeExtensionRegistryRitualsResolver(): RitualsResolver {
  return async (sourceLauncherId: string) => {
    const registry = ExtensionRegistry.getInstance();
    const assistants = registry.getAssistants();
    const norm = sourceLauncherId.startsWith('ext-') ? sourceLauncherId : `ext-${sourceLauncherId}`;
    for (const a of assistants) {
      const candidate = a as { id?: string; rituals?: Array<{ name: string; cadence: string }> };
      if (candidate.id === norm || candidate.id === sourceLauncherId) {
        return candidate.rituals;
      }
    }
    return undefined;
  };
}

const DAY_OF_WEEK_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * Translate a launcher ritual cadence string into a cron expression compatible
 * with the `croner` library used by CronService. Returns null when the cadence
 * cannot be parsed; the caller logs + skips.
 *
 * Supported forms (all bundle rituals today use the first):
 *   `weekly:<day>:<HH>:<MM>`  →  `MM HH * * <dow>`
 *   `daily:<HH>:<MM>`         →  `MM HH * * *`
 *   `daily`                   →  `0 9 * * *` (sensible default)
 */
export function cadenceToCronExpr(cadence: string): string | null {
  const normalized = cadence.trim().toLowerCase();
  if (normalized === 'daily') return '0 9 * * *';

  const parts = normalized.split(':');

  if (parts[0] === 'weekly' && parts.length === 4) {
    const day = DAY_OF_WEEK_INDEX[parts[1]];
    if (day === undefined) return null;
    const hour = Number(parts[2]);
    const minute = Number(parts[3]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return `${minute} ${hour} * * ${day}`;
  }

  if (parts[0] === 'daily' && parts.length === 3) {
    const hour = Number(parts[1]);
    const minute = Number(parts[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return `${minute} ${hour} * * *`;
  }

  return null;
}

export interface RitualScheduler {
  /** (Re)install every ritual declared by the team's source launcher. Idempotent. */
  installRituals(team: TTeam): Promise<void>;
  /** Remove every ritual cron previously installed for this team. */
  uninstallRituals(team: TTeam): Promise<void>;
}

export class CronRitualScheduler implements RitualScheduler {
  constructor(
    private readonly cronService: CronService,
    private readonly resolveRituals: RitualsResolver
  ) {}

  async installRituals(team: TTeam): Promise<void> {
    if (!team.sourceLauncherId) return;

    let rituals: Array<{ name: string; cadence: string }> | undefined;
    try {
      rituals = await this.resolveRituals(team.sourceLauncherId);
    } catch (err) {
      logger.warn(
        `[RitualScheduler] failed to resolve rituals for team ${team.id}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    if (!rituals || rituals.length === 0) return;

    const leader = team.agents.find((a) => a.role === 'leader');
    if (!leader?.conversationId) {
      logger.warn(`[RitualScheduler] team ${team.id} has no leader conversation; skipping rituals`);
      return;
    }

    // Clear any prior rituals so install is idempotent across re-promotions
    // and avoids stacking duplicates when bundle definitions evolve.
    await this.uninstallRituals(team);

    for (const ritual of rituals) {
      const expr = cadenceToCronExpr(ritual.cadence);
      if (!expr) {
        logger.warn(
          `[RitualScheduler] unsupported cadence "${ritual.cadence}" for ritual "${ritual.name}" on team ${team.id}; skipping`
        );
        continue;
      }

      const schedule: CronSchedule = { kind: 'cron', expr, description: ritual.cadence };
      const promptText = buildRitualPrompt(team.name, ritual.name);

      try {
        await this.cronService.addJob({
          name: `${team.name} · ${ritual.name}`,
          description: ritual.cadence,
          schedule,
          message: promptText,
          conversationId: leader.conversationId,
          conversationTitle: team.name,
          agentType: leader.agentType as AgentBackend,
          createdBy: 'agent',
          executionMode: 'existing',
          agentConfig: {
            backend: leader.agentType as AgentBackend,
            name: leader.agentName,
            cliPath: leader.cliPath,
            customAgentId: leader.customAgentId,
            modelId: leader.model,
            mode: 'bypassPermissions',
            workspace: team.workspace || undefined,
            // v0.4.7.1 (ENGINE-2) — distinguishes ritual crons from
            // user-NL-scheduled crons (which also use createdBy:'agent'
            // via MessageMiddleware). SignalCollector + uninstallRituals
            // filter on this tag so we don't (a) sweep user crons on team
            // demote, or (b) false-positive Level 1 of the kickoff cascade
            // when a user-scheduled cron on a Standing leader conv fires.
            configOptions: { kind: 'ritual' },
          },
          bypassUniqueGuard: true,
        });
      } catch (err) {
        logger.warn(
          `[RitualScheduler] failed to install ritual "${ritual.name}" for team ${team.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  async uninstallRituals(team: TTeam): Promise<void> {
    const leader = team.agents.find((a) => a.role === 'leader');
    if (!leader?.conversationId) return;
    let jobs: Awaited<ReturnType<CronService['listJobsByConversation']>>;
    try {
      jobs = await this.cronService.listJobsByConversation(leader.conversationId);
    } catch (err) {
      logger.warn(
        `[RitualScheduler] failed to list crons for team ${team.id}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    // v0.4.7.1 (ENGINE-2) — filter on the explicit `kind: 'ritual'` tag
    // set in installRituals (via agentConfig.configOptions), NOT on
    // createdBy === 'agent'. MessageMiddleware also uses createdBy:'agent'
    // for user-NL-scheduled crons on chat conversations, including
    // potentially on the leader conversation if the user asked the agent
    // "schedule X." Sweeping those on team demote would silently delete
    // the user's work.
    const ritualJobs = jobs.filter(
      (j) =>
        j.metadata.createdBy === 'agent' &&
        j.metadata.agentConfig?.configOptions?.kind === 'ritual'
    );
    for (const job of ritualJobs) {
      try {
        await this.cronService.removeJob(job.id);
      } catch (err) {
        logger.warn(
          `[RitualScheduler] failed to remove ritual cron ${job.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}

function buildRitualPrompt(teamName: string, ritualName: string): string {
  return `Run the "${ritualName}" ritual for the ${teamName} team. Coordinate with teammates as needed using the team_send_message tool, then summarize the outcome.`;
}
