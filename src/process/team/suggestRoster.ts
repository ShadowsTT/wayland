/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * W3c - Deterministic roster suggester.
 *
 * Given a goal text + the available specialist pool, returns 4-6 specialist
 * ids picked by keyword-relevance scoring. Pure function: no LLM dispatch,
 * no IPC, no filesystem.
 */

import { recommendBackend, type BackendId } from './backends/resolveAvailableBackends';

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'do',
  'for',
  'from',
  'have',
  'he',
  'i',
  "i'm",
  "i've",
  'in',
  'is',
  'it',
  'its',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'that',
  'the',
  'their',
  'they',
  'this',
  'to',
  'we',
  "we're",
  'what',
  'will',
  'with',
  'you',
  'your',
  'need',
  'want',
  'help',
  'build',
  'make',
  'create',
  'run',
  'doing',
  'some',
  'someone',
  'little',
  'small',
  'team',
]);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));

export type SuggestSpecialist = {
  id: string;
  name: string;
  description: string;
  agentType?: string;
};

export type SuggestRosterInput = {
  goalText: string;
  specialists: SuggestSpecialist[];
  detectedBackends: BackendId[];
  /** Optional: how many teammates to include (default 4, clamped to available pool). */
  targetSize?: number;
};

export type SuggestedRosterEntry = {
  specialistId: string;
  backend: BackendId;
  score: number;
  /**
   * Distinct goal tokens that matched this specialist's name/description, in
   * goal-token order. Empty when the suggester fell back to defaults (no
   * keywords matched) - the renderer renders that as "recommended".
   */
  matchedTerms: string[];
};

export type SuggestRosterResult = {
  leader: SuggestedRosterEntry | null;
  teammates: SuggestedRosterEntry[];
  /** True when the goal text scored zero matches against every specialist (fallback to top-N by name length). */
  fellBackToDefaults: boolean;
};

/** Pure scoring + selection. No I/O. */
export function suggestRoster(input: SuggestRosterInput): SuggestRosterResult {
  const goalTokens = tokenize(input.goalText);
  const target = Math.max(2, Math.min(input.targetSize ?? 5, Math.min(6, input.specialists.length)));

  // Score each specialist by token overlap with name + description. Capture the
  // matched tokens too so the renderer can show WHY each pick was made. Score is
  // still the raw match count (one per goal token, dupes included) so selection
  // ordering is byte-for-byte identical to before; matchedTerms is deduped for
  // display only.
  const scored = input.specialists.map((s) => {
    const haystack = `${s.name.toLowerCase()} ${s.description.toLowerCase()}`;
    let score = 0;
    const matched: string[] = [];
    for (const tok of goalTokens) {
      if (haystack.includes(tok)) {
        score += 1;
        if (!matched.includes(tok)) matched.push(tok);
      }
    }
    return { spec: s, score, matchedTerms: matched };
  });

  const allZero = scored.every((s) => s.score === 0);
  let picked = scored;
  if (allZero) {
    // Fallback: deterministic ordering by name length asc - short-named specialists
    // tend to be core roles (Scout, Quill, Lens) in the bundle convention.
    picked = scored.toSorted((a, b) => a.spec.name.length - b.spec.name.length);
  } else {
    picked = scored.toSorted((a, b) => b.score - a.score);
  }

  picked = picked.slice(0, target);

  if (picked.length === 0) {
    return { leader: null, teammates: [], fellBackToDefaults: allZero };
  }

  // Leader = highest scorer (or first after fallback sort).
  const [leaderEntry, ...teammateEntries] = picked;

  const toEntry = (s: { spec: SuggestSpecialist; score: number; matchedTerms: string[] }): SuggestedRosterEntry => ({
    specialistId: s.spec.id,
    backend: recommendBackend(input.detectedBackends, s.spec.agentType),
    score: s.score,
    // On fallback every score is 0, so matchedTerms is already []. Keep it
    // explicit for readers: [] means "default pick".
    matchedTerms: allZero ? [] : s.matchedTerms,
  });

  return {
    leader: toEntry(leaderEntry),
    teammates: teammateEntries.map(toEntry),
    fellBackToDefaults: allZero,
  };
}
