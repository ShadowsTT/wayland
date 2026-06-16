/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { selectImageModelIds } from '@process/providers/legacyModelConfigBridge';
import type { CatalogModel } from '@process/providers/types';

function model(id: string, kind: CatalogModel['kind'], releaseDate?: string): CatalogModel {
  return { id, providerId: 'openai', displayName: id, family: id, kind, enriched: true, tags: [], releaseDate };
}

describe('selectImageModelIds', () => {
  it('keeps only kind:image models', () => {
    const catalog = [model('gpt-5', 'text'), model('gpt-image-1.5', 'image'), model('whisper-1', 'audio')];
    expect(selectImageModelIds(catalog)).toEqual(['gpt-image-1.5']);
  });

  it('sorts newest releaseDate first so the best current model leads', () => {
    const catalog = [
      model('gpt-image-1', 'image', '2025-04-24'),
      model('chatgpt-image-latest', 'image', '2025-12-16'),
      model('gpt-image-1.5', 'image', '2025-11-25'),
    ];
    expect(selectImageModelIds(catalog)).toEqual(['chatgpt-image-latest', 'gpt-image-1.5', 'gpt-image-1']);
  });

  it('places image models without a releaseDate last, stably', () => {
    const catalog = [model('no-date-a', 'image'), model('dated', 'image', '2025-11-25'), model('no-date-b', 'image')];
    expect(selectImageModelIds(catalog)).toEqual(['dated', 'no-date-a', 'no-date-b']);
  });

  it('returns an empty list when the catalog has no image models', () => {
    expect(selectImageModelIds([model('gpt-5', 'text')])).toEqual([]);
  });
});
