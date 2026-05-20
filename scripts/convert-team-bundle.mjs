#!/usr/bin/env node
/**
 * convert-team-bundle.mjs
 *
 * Converts the Wayland Teams skills bundle into canonical SKILL.md files.
 *
 * Usage:
 *   node scripts/convert-team-bundle.mjs [--bundle <path>] [--out <dir>]
 *
 * Defaults:
 *   --bundle  /Users/seandonahoe/dev/waylandteams/contributes/skills.json
 *   --out     ./out/team-skills
 *
 * Environment overrides (lower priority than CLI flags):
 *   TEAM_BUNDLE_PATH   path to skills.json
 *   TEAM_SKILLS_OUT    output directory
 *
 * Exit codes:
 *   0  success
 *   1  error (missing file, empty body, write failure)
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { argv } from 'node:process';

const DEFAULT_BUNDLE = '/Users/seandonahoe/dev/waylandteams/contributes/skills.json';
const DEFAULT_OUT = './out/team-skills';

/** Convert a name string to kebab-case. */
export function toKebab(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Infer category from the file path in the bundle entry.
 * Path shape: "skills/<category>/<slug>.md"
 * Falls back to 'general' if the shape doesn't match.
 */
export function inferCategory(filePath) {
  const parts = filePath.split('/');
  // parts[0] = "skills", parts[1] = category, parts[2] = slug.md
  if (parts.length >= 3 && parts[0] === 'skills') {
    return parts[1];
  }
  return 'general';
}

/**
 * Build the YAML frontmatter block for a skill entry.
 */
export function buildFrontmatter(entry, category) {
  // Escape single quotes in string values by doubling them (YAML single-quoted style).
  const esc = (s) => s.replace(/'/g, "''");
  return [
    '---',
    `name: '${esc(entry.name)}'`,
    `description: '${esc(entry.description)}'`,
    `source: 'team'`,
    `category: '${esc(category)}'`,
    'security:',
    "  verdict: 'unscanned'",
    '  findings: []',
    '  scannedAt: 0',
    '  scannerVersion: 0',
    '  llmScanned: false',
    '---',
  ].join('\n');
}

/**
 * Core converter. Accepts explicit parameters so it can be called from tests
 * without touching the filesystem at the default paths.
 *
 * @param {object[]} entries          - Parsed skills.json array
 * @param {string}   teamsRoot        - Root directory of the teams bundle
 * @param {string}   outDir           - Output directory for SKILL.md files
 * @param {{ readBody?: (p: string) => string }} [opts]
 *   Optional overrides for I/O (used in tests).
 * @returns {{ count: number }}
 */
export function convertTeamBundle(entries, teamsRoot, outDir, opts = {}) {
  const readBody = opts.readBody ?? ((p) => readFileSync(p, 'utf8'));

  // Clean output dir for idempotency.
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  for (const entry of entries) {
    const bodyPath = resolve(teamsRoot, entry.file);
    let body;
    try {
      body = readBody(bodyPath);
    } catch (err) {
      throw new Error(`Cannot read body for skill '${entry.name}' at '${bodyPath}': ${err.message}`);
    }

    if (!body || !body.trim()) {
      throw new Error(`Empty body for skill '${entry.name}' at '${bodyPath}'`);
    }

    const category = inferCategory(entry.file);
    const frontmatter = buildFrontmatter(entry, category);
    const skillDir = join(outDir, toKebab(entry.name));
    mkdirSync(skillDir, { recursive: true });

    const content = `${frontmatter}\n\n${body.trim()}\n`;
    writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf8');
  }

  return { count: entries.length };
}

/** Parse CLI arguments. Returns { bundle, out }. */
function parseCli(args) {
  const result = {
    bundle: process.env.TEAM_BUNDLE_PATH ?? DEFAULT_BUNDLE,
    out: process.env.TEAM_SKILLS_OUT ?? DEFAULT_OUT,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bundle' && args[i + 1]) result.bundle = args[++i];
    else if (args[i] === '--out' && args[i + 1]) result.out = args[++i];
  }
  return result;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

const isMain =
  typeof process !== 'undefined' &&
  argv[1] &&
  resolve(argv[1]) === resolve(new URL(import.meta.url).pathname);

if (isMain) {
  const { bundle, out } = parseCli(argv.slice(2));

  let entries;
  try {
    const raw = readFileSync(bundle, 'utf8');
    entries = JSON.parse(raw);
  } catch (err) {
    console.error(`[convert-team-bundle] Failed to read bundle at '${bundle}': ${err.message}`);
    process.exit(1);
  }

  const teamsRoot = dirname(dirname(bundle)); // skills.json is at <root>/contributes/skills.json

  try {
    const { count } = convertTeamBundle(entries, teamsRoot, out);
    console.log(`[convert-team-bundle] Wrote ${count} SKILL.md files to '${out}'`);
  } catch (err) {
    console.error(`[convert-team-bundle] ${err.message}`);
    process.exit(1);
  }
}
