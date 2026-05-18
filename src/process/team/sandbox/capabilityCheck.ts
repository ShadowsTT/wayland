/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * W4b — Capability grant check helpers.
 *
 * Single source of truth for "is capability X granted on team Y" queries.
 * Used by the MCP tool dispatch (TeamMcpServer) and will be reused by the
 * workspace-FS IPC handlers in W4c.
 *
 * Contract:
 *   - A team that is NOT sandboxed bypasses the grant map entirely — every
 *     capability is considered granted. Pre-W4 teams have `isSandboxed`
 *     undefined; we treat that as "trusted" (non-sandboxed).
 *   - A sandboxed team consults `importCapabilityGrants[cap].by_user`. Any
 *     missing entry, or `by_user: false`, denies the capability.
 *
 * `assertCapGranted` throws `TeamSandboxedError` (defined in W4a) so the
 * existing MCP error path serializes a uniform message to the agent.
 */

import { TeamSandboxedError } from '@process/team/importExport/errors';
import type { TTeam } from '@process/team/types';

/**
 * Names of the five capabilities the W4a `TeamExportSchema` defines. Kept in
 * sync manually because reusing the Zod-derived type would force a runtime
 * import of the schema into the hot MCP path.
 */
export type TeamCapabilities = {
  canReadFiles: boolean;
  canWriteFiles: boolean;
  canSpawnAgents: boolean;
  canNetworkRequest: boolean;
  canCrossTeamMessage: boolean;
};

export type TeamCapability = keyof TeamCapabilities;

/**
 * Returns true when `cap` is currently allowed on `team`. Non-sandboxed
 * teams always return true. Sandboxed teams require an explicit
 * `by_user: true` entry in `importCapabilityGrants`.
 */
export function isCapGranted(team: TTeam, cap: TeamCapability): boolean {
  if (team.isSandboxed !== true) return true;
  const grants = team.importCapabilityGrants ?? {};
  return grants[cap]?.by_user === true;
}

/**
 * Throws `TeamSandboxedError` with a descriptive message when `cap` is
 * denied on `team`. Intentionally a no-op when allowed so callers can wrap
 * any IPC entry-point in a single line.
 */
export function assertCapGranted(team: TTeam, cap: TeamCapability): void {
  if (isCapGranted(team, cap)) return;
  throw new TeamSandboxedError(
    `Sandboxed team "${team.name}" lacks capability "${cap}". ` +
      `Grant it via Settings → Teams → Trust to enable.`
  );
}
