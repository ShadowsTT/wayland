/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Curator — the pure curation function of the two-tier model store.
 *
 * The assembler produces a full `CatalogModel[]` (every model every source
 * exposes). The Curator derives the much smaller `CuratedModel[]` view the chat
 * model picker shows: the latest model in each family, plus the one revision
 * before it.
 *
 * ## Rules
 *
 * 1. Only `kind === 'text'` models are curated. Image / audio / embedding models
 *    stay in the full catalog for other features but never reach the picker.
 * 2. Text models are grouped by `family`.
 * 3. Within a family, models are ordered newest-first by `releaseDate`. A model
 *    with no `releaseDate` sorts last.
 * 4. **A family is eligible for the recommended set only when at least one of
 *    its models is `enriched: true`.** models.dev enrichment is the local
 *    quality signal that a family is current/relevant — providers like OpenAI
 *    expose legacy ids on `/v1/models` (Babbage, Davinci, dated GPT-3.5
 *    Turbos, internal Computer-Use previews, …) that models.dev correctly
 *    declines to track. Without this filter every unmatched id becomes a
 *    singleton "family" and every legacy model gets flagged Recommended, which
 *    defeats the entire two-tier curation premise. Unenriched models still
 *    flow through to the catalog (visible in "More in the catalog") — they
 *    just don't get the `recommended: true` badge.
 * 5. Within an eligible family, the newest model → `recommended: true,
 *    enabled: true, role: 'flagship'`. The second-newest → `recommended: true,
 *    enabled: true, role: 'previous'`. A single-model family yields only a
 *    flagship.
 * 6. Every other model — including every model in an ineligible (entirely
 *    unenriched) family — gets `recommended: false, enabled: false`, no `role`.
 *
 * Fast/cheap families (Haiku, GPT mini, Gemini Flash) are NOT special-cased —
 * they form their own families and are surfaced by exactly the same rule. Cost
 * is deliberately not an input to curation. The `role: 'fast'` value exists in
 * the type for future use but this curator never emits it.
 *
 * This function is genuinely PURE: no network, no filesystem, no `Date.now()`.
 * Given the same input it always returns a deeply equal result, and it never
 * mutates its input.
 */

import type { CatalogModel, CuratedModel } from '../types';

export class Curator {
  /**
   * Derive the curated picker view from the full catalog.
   *
   * Returns one `CuratedModel` per text model in `catalog` (image/audio/
   * embedding models are dropped). The returned array's order groups a family's
   * models together, newest-first; family order itself is not significant.
   */
  curate(catalog: CatalogModel[]): CuratedModel[] {
    const textModels = catalog.filter((model) => model.kind === 'text');
    const families = groupByFamily(textModels);

    const curated: CuratedModel[] = [];
    for (const familyModels of families.values()) {
      const ordered = sortNewestFirst(familyModels);
      // A family is eligible for recommendation only when at least one of its
      // models was enriched against models.dev (Rule 4). Entirely-unenriched
      // families surface every model as `recommended: false` — they're still
      // pickable, just not flagged.
      const eligible = ordered.some((model) => model.enriched);
      ordered.forEach((model, index) => {
        curated.push(curateOne(model, index, eligible));
      });
    }
    return curated;
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Group models by `family`, preserving each family's first-seen order. A `Map`
 * keeps iteration deterministic for a given input — required for purity.
 */
function groupByFamily(models: CatalogModel[]): Map<string, CatalogModel[]> {
  const families = new Map<string, CatalogModel[]>();
  for (const model of models) {
    const bucket = families.get(model.family);
    if (bucket) {
      bucket.push(model);
    } else {
      families.set(model.family, [model]);
    }
  }
  return families;
}

/**
 * Sort a family's models newest-first by `releaseDate`. A model without a date
 * sorts after every dated model. The sort is stable on a copy — the input array
 * is never mutated, so the function stays pure.
 */
function sortNewestFirst(models: CatalogModel[]): CatalogModel[] {
  return models.toSorted((a, b) => {
    const aDate = a.releaseDate;
    const bDate = b.releaseDate;
    if (aDate && bDate) return bDate < aDate ? -1 : bDate > aDate ? 1 : 0;
    if (aDate) return -1; // dated model precedes an undated one
    if (bDate) return 1;
    return 0; // both undated — preserve relative order
  });
}

/**
 * Convert a `CatalogModel` into a `CuratedModel` given its rank within its
 * family (0 = newest) and whether its family is eligible for recommendation
 * (Rule 4 — at least one model in the family was enriched against models.dev).
 *
 * In an eligible family, ranks 0 and 1 are recommended; everything else is not.
 * In an ineligible family every model is `recommended: false` — the model is
 * still pickable from "More in the catalog" but doesn't get the flagship badge.
 */
function curateOne(model: CatalogModel, rank: number, familyEligible: boolean): CuratedModel {
  if (familyEligible && rank === 0) {
    return { ...model, recommended: true, enabled: true, role: 'flagship' };
  }
  if (familyEligible && rank === 1) {
    return { ...model, recommended: true, enabled: true, role: 'previous' };
  }
  return { ...model, recommended: false, enabled: false };
}
