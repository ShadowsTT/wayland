/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import path from 'path';
import { WAYLAND_KNOWLEDGE_DIR } from './bootstrap';

/**
 * Read, write, inject and manage a project's `.wayland/` knowledge.
 *
 * Knowledge lives at `{workspace}/.wayland/` and is scoped to ONE project (the
 * deliberate fix for Foundry's "notebooks leaked into every chat" bug). It is
 * surfaced two ways:
 *   1. The project workspace UI (editable instructions / rules / decisions +
 *      dropped reference files).
 *   2. Auto-injection: when a chat is created inside a project, the substantive
 *      knowledge is appended to that one conversation's system-rules channel
 *      (see ConversationServiceImpl.createConversation). Per-conversation, never
 *      global, so it cannot leak into non-project chats.
 */

/** The three first-class, editable knowledge documents. */
export type KnowledgeKind = 'context' | 'rules' | 'decisions';

const KNOWLEDGE_FILE: Record<KnowledgeKind, string> = {
  context: 'CONTEXT.md',
  rules: 'rules.md',
  decisions: 'decisions.md',
};

/** Section labels used when composing the injected prompt block. */
const INJECT_LABEL: Record<KnowledgeKind, string> = {
  context: 'Project context',
  rules: 'Project rules & conventions',
  decisions: 'Project decisions',
};

const REFERENCE_DIR = 'reference';
const SUMMARY_FILE = 'summaries.json';

export type KnowledgeSummaries = Partial<Record<KnowledgeKind, string>>;

export type ProjectKnowledge = {
  context: string;
  rules: string;
  decisions: string;
};

export type ReferenceFile = {
  name: string;
  path: string;
  size: number;
};

const knowledgeRoot = (workspace: string): string => path.join(workspace, WAYLAND_KNOWLEDGE_DIR);

const readIfExists = async (filePath: string): Promise<string> => {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
};

/** Read all three knowledge documents (empty string for any missing file). */
export async function readProjectKnowledge(workspace: string): Promise<ProjectKnowledge> {
  if (!workspace || !workspace.trim()) return { context: '', rules: '', decisions: '' };
  const root = knowledgeRoot(workspace);
  const [context, rules, decisions] = await Promise.all([
    readIfExists(path.join(root, KNOWLEDGE_FILE.context)),
    readIfExists(path.join(root, KNOWLEDGE_FILE.rules)),
    readIfExists(path.join(root, KNOWLEDGE_FILE.decisions)),
  ]);
  return { context, rules, decisions };
}

/** Write one knowledge document, creating the `.wayland/` folder if needed. */
export async function writeProjectKnowledge(workspace: string, kind: KnowledgeKind, content: string): Promise<void> {
  if (!workspace || !workspace.trim()) throw new Error('Project has no workspace folder');
  const root = knowledgeRoot(workspace);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, KNOWLEDGE_FILE[kind]), content, 'utf-8');
}

/**
 * Strip the seeded boilerplate so a freshly-bootstrapped, unedited document
 * injects NOTHING (no prompt noise). We drop the top `# heading`, instructional
 * blockquote lines (`> ...`), and surrounding whitespace; whatever real content
 * the user typed remains. Returns '' when only boilerplate is present.
 */
const substantive = (raw: string): string => {
  if (!raw) return '';
  const body = raw
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (t.startsWith('>')) return false; // instructional blockquote
      if (/^#\s/.test(t)) return false; // top-level heading (the seeded title)
      return true;
    })
    .join('\n')
    .trim();
  return body;
};

/**
 * Compose the project's substantive knowledge into a single block ready to
 * append to a conversation's system-rules channel. Returns '' when the project
 * has no workspace or no edited knowledge yet (so nothing is injected).
 */
export async function loadProjectKnowledgeBlock(workspace: string): Promise<string> {
  const k = await readProjectKnowledge(workspace);
  const sections: string[] = [];
  (Object.keys(KNOWLEDGE_FILE) as KnowledgeKind[]).forEach((kind) => {
    const body = substantive(k[kind]);
    if (body) sections.push(`## ${INJECT_LABEL[kind]}\n\n${body}`);
  });
  if (sections.length === 0) return '';
  return `[Project Knowledge — shared context for every chat in this project]\n\n${sections.join('\n\n')}`;
}

/**
 * Read the editable one-line summaries for each knowledge doc. Stored in
 * `.wayland/summaries.json` (separate from the docs so a doc edit never clobbers
 * its summary and vice-versa). Returns {} when absent.
 */
export async function readProjectSummaries(workspace: string): Promise<KnowledgeSummaries> {
  if (!workspace || !workspace.trim()) return {};
  try {
    const raw = await fs.readFile(path.join(knowledgeRoot(workspace), SUMMARY_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as KnowledgeSummaries;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Write/replace one doc's one-line summary, preserving the others. */
export async function writeProjectSummary(workspace: string, kind: KnowledgeKind, summary: string): Promise<void> {
  if (!workspace || !workspace.trim()) throw new Error('Project has no workspace folder');
  const root = knowledgeRoot(workspace);
  await fs.mkdir(root, { recursive: true });
  const current = await readProjectSummaries(workspace);
  current[kind] = summary;
  await fs.writeFile(path.join(root, SUMMARY_FILE), JSON.stringify(current, null, 2), 'utf-8');
}

/**
 * Append one decision to `.wayland/decisions.md` as a dated bullet and return
 * the updated document. This is the manual "+ Add decision" path for the Memory
 * tab; the decisions doc is also auto-injected into every chat in the project.
 */
export async function appendProjectDecision(workspace: string, text: string): Promise<string> {
  if (!workspace || !workspace.trim()) throw new Error('Project has no workspace folder');
  const trimmed = text.trim();
  if (!trimmed) {
    const current = await readProjectKnowledge(workspace);
    return current.decisions;
  }
  const root = knowledgeRoot(workspace);
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, KNOWLEDGE_FILE.decisions);
  const existing = await readIfExists(file);
  const date = new Date().toISOString().slice(0, 10);
  const bullet = `- ${date} — ${trimmed.replace(/\n+/g, ' ')}`;
  const next = existing.trim() ? `${existing.replace(/\s+$/, '')}\n${bullet}\n` : `${bullet}\n`;
  await fs.writeFile(file, next, 'utf-8');
  return next;
}

/** List files dropped into the project's `.wayland/reference/` folder. */
export async function listProjectReference(workspace: string): Promise<ReferenceFile[]> {
  if (!workspace || !workspace.trim()) return [];
  const dir = path.join(knowledgeRoot(workspace), REFERENCE_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files = await Promise.all(
    entries.map(async (name): Promise<ReferenceFile | null> => {
      try {
        const full = path.join(dir, name);
        const stat = await fs.stat(full);
        if (!stat.isFile()) return null;
        return { name, path: full, size: stat.size };
      } catch {
        return null;
      }
    })
  );
  return files.filter((f): f is ReferenceFile => f !== null).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Copy dropped files into `.wayland/reference/`. Returns the resulting file
 * list. Name collisions are de-duplicated with a numeric suffix so a re-drop
 * never silently overwrites.
 */
export async function addProjectReference(workspace: string, sourcePaths: string[]): Promise<ReferenceFile[]> {
  if (!workspace || !workspace.trim()) throw new Error('Project has no workspace folder');
  const dir = path.join(knowledgeRoot(workspace), REFERENCE_DIR);
  await fs.mkdir(dir, { recursive: true });

  for (const src of sourcePaths) {
    try {
      const stat = await fs.stat(src);
      if (!stat.isFile()) continue; // skip directories for now
      const dest = await uniqueDest(dir, path.basename(src));
      await fs.copyFile(src, dest);
    } catch (err) {
      console.warn('[projectKnowledge] failed to copy reference file:', src, err);
    }
  }
  return listProjectReference(workspace);
}

/** Remove one reference file by its basename (path-traversal guarded). */
export async function removeProjectReference(workspace: string, name: string): Promise<ReferenceFile[]> {
  if (!workspace || !workspace.trim()) throw new Error('Project has no workspace folder');
  const safe = path.basename(name); // never escape the reference dir
  const dir = path.join(knowledgeRoot(workspace), REFERENCE_DIR);
  try {
    await fs.unlink(path.join(dir, safe));
  } catch (err) {
    console.warn('[projectKnowledge] failed to remove reference file:', safe, err);
  }
  return listProjectReference(workspace);
}

/** Resolve a non-colliding destination path inside `dir` for `fileName`. */
async function uniqueDest(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${base}-${n}${ext}`);
      n += 1;
    } catch {
      return candidate;
    }
  }
}
