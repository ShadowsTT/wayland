/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { getSkillsDir, getBuiltinSkillsCopyDir, loadSkillsContent } from '@process/utils/initStorage';
import { AcpSkillManager, buildSkillsIndexText, type SkillIndex } from './AcpSkillManager';
import { getTeamGuidePrompt } from '@process/team/prompts/teamGuidePrompt.ts';
import { resolveLeaderAssistantLabel } from '@process/team/prompts/teamGuideAssistant.ts';

/**
 * First message processing configuration
 */
export interface FirstMessageConfig {
  /** Preset context/rules */
  presetContext?: string;
  /** Enabled skills list */
  enabledSkills?: string[];
  /** Builtin auto-injected skills to exclude */
  excludeBuiltinSkills?: string[];
  /** Inject Team mode guidance prompt when agent has aion_create_team capability */
  enableTeamGuide?: boolean;
  /** Agent backend type (e.g. 'claude', 'codex') — used to populate team guide prompt */
  backend?: string;
  /**
   * Preset assistant id backing this conversation (e.g. 'builtin-word-creator').
   * When set, the team guide prompt shows the assistant's display name on the
   * Leader row instead of the raw backend key.
   */
  presetAssistantId?: string;
}

/**
 * Build system instructions content (full skills content injection - for Gemini)
 *
 * @param config - First message configuration
 * @returns System instructions string or undefined
 */
export async function buildSystemInstructions(config: FirstMessageConfig): Promise<string | undefined> {
  const instructions: string[] = [];

  // Add preset context
  if (config.presetContext) {
    instructions.push(config.presetContext);
  }

  // Load and add skills content
  if (config.enabledSkills && config.enabledSkills.length > 0) {
    const skillsContent = await loadSkillsContent(config.enabledSkills);
    if (skillsContent) {
      instructions.push(skillsContent);
    }
  }

  // Inject Team Guide prompt when agent has team guide capability
  if (config.enableTeamGuide) {
    const leaderLabel = await resolveLeaderAssistantLabel(config.presetAssistantId);
    instructions.push(getTeamGuidePrompt({ backend: config.backend, leaderLabel }));
  }

  if (instructions.length === 0) {
    return undefined;
  }

  return instructions.join('\n\n');
}

/**
 * Inject system instructions for first message (full skills content - for Gemini)
 *
 * Note: Use direct prefix instead of XML tags to ensure external agents like Claude Code CLI can recognize it
 *
 * @param content - Original message content
 * @param config - First message configuration
 * @returns Message content with system instructions injected
 */
export async function prepareFirstMessage(content: string, config: FirstMessageConfig): Promise<string> {
  const systemInstructions = await buildSystemInstructions(config);

  if (!systemInstructions) {
    return content;
  }

  // Use direct prefix format similar to Gemini Agent to ensure Claude/Codex can recognize it
  return `[Assistant Rules - You MUST follow these instructions]\n${systemInstructions}\n\n[User Request]\n${content}`;
}

/**
 * Prepare first message: inject rules + skills INDEX (not full content)
 *
 * Used for ACP agents (Claude/OpenCode) and Codex; Agent reads skill files on-demand using Read tool.
 *
 * Note: Builtin skills (in _builtin/ directory) are auto-injected, no need to specify in enabledSkills
 *
 * @param content - Original message content
 * @param config - First message configuration
 * @returns Message content with injected instructions and loaded skills list
 */
export async function prepareFirstMessageWithSkillsIndex(
  content: string,
  config: FirstMessageConfig
): Promise<{ content: string; loadedSkills: SkillIndex[] }> {
  const instructions: string[] = [];
  let loadedSkills: SkillIndex[] = [];

  // 1. Add preset rules
  if (config.presetContext) {
    instructions.push(config.presetContext);
  }

  // 2. Load skills INDEX (including builtin skills + optional skills)
  // Use singleton to avoid repeated filesystem scans
  const skillManager = AcpSkillManager.getInstance(config.enabledSkills);
  // discoverSkills auto-loads builtin skills first
  await skillManager.discoverSkills(config.enabledSkills, config.excludeBuiltinSkills);

  // Only inject if there are any skills
  if (skillManager.hasAnySkills()) {
    const excludeSet = new Set(config.excludeBuiltinSkills ?? []);
    // Filter out excluded builtin skills — the singleton cache may not reflect excludeBuiltinSkills
    const skillsIndex = skillManager.getSkillsIndex().filter((s) => !excludeSet.has(s.name));
    loadedSkills = skillsIndex;
    if (skillsIndex.length > 0) {
      // getSkillsDir() already returns CLI-safe path (symlink on macOS)
      const skillsDir = getSkillsDir();
      const builtinSkillsCopyDir = getBuiltinSkillsCopyDir();
      const builtinSkillsDir = builtinSkillsCopyDir + '/_builtin';
      const indexText = buildSkillsIndexText(skillsIndex);

      // Tell Agent where skills files are located for on-demand reading
      const skillsInstruction = `${indexText}

[Skills Location]
Skills are stored in three locations:
- Builtin skills (auto-enabled): ${builtinSkillsDir}/{skill-name}/SKILL.md
- Bundled skills: ${builtinSkillsCopyDir}/{skill-name}/SKILL.md
- User custom skills: ${skillsDir}/{skill-name}/SKILL.md

Each skill has a SKILL.md file containing detailed instructions.
To use a skill, read its SKILL.md file when needed.

For example:
- Builtin "cron" skill: ${builtinSkillsDir}/cron/SKILL.md
- Bundled "pptx" skill: ${builtinSkillsCopyDir}/pptx/SKILL.md`;

      instructions.push(skillsInstruction);
    }
  }

  // 3. Inject Team Guide prompt when agent has team guide capability
  if (config.enableTeamGuide) {
    const leaderLabel = await resolveLeaderAssistantLabel(config.presetAssistantId);
    instructions.push(getTeamGuidePrompt({ backend: config.backend, leaderLabel }));
  }

  if (instructions.length === 0) {
    return { content, loadedSkills };
  }

  const systemInstructions = instructions.join('\n\n');
  return {
    content: `[Assistant Rules - You MUST follow these instructions]\n${systemInstructions}\n\n[User Request]\n${content}`,
    loadedSkills,
  };
}

/**
 * Build system instructions with skills INDEX only (no full content - for Gemini)
 *
 * Gemini has no file read tool and cannot read SKILL.md files on its own.
 * When Gemini needs detailed instructions for a skill, it outputs [LOAD_SKILL: skill-name],
 * and the system intercepts it and sends back the full skill content as [System Response].
 *
 * @param config - First message configuration
 * @returns System instructions string or undefined
 */
export async function buildSystemInstructionsWithSkillsIndex(config: FirstMessageConfig): Promise<string | undefined> {
  const instructions: string[] = [];

  // Add preset context
  if (config.presetContext) {
    instructions.push(config.presetContext);
  }

  // Load skills INDEX (including builtin skills + optional skills)
  const skillManager = AcpSkillManager.getInstance(config.enabledSkills);
  await skillManager.discoverSkills(config.enabledSkills, config.excludeBuiltinSkills);

  if (skillManager.hasAnySkills()) {
    const excludeSet = new Set(config.excludeBuiltinSkills ?? []);
    const skillsIndex = skillManager.getSkillsIndex().filter((s) => !excludeSet.has(s.name));
    if (skillsIndex.length > 0) {
      const indexText = buildSkillsIndexText(skillsIndex);
      instructions.push(indexText);
    }
  }

  // Inject Team Guide prompt when agent has team guide capability
  if (config.enableTeamGuide) {
    const leaderLabel = await resolveLeaderAssistantLabel(config.presetAssistantId);
    instructions.push(getTeamGuidePrompt({ backend: config.backend, leaderLabel }));
  }

  if (instructions.length === 0) {
    return undefined;
  }

  return instructions.join('\n\n');
}
