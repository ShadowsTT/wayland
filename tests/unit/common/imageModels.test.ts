/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { isImageModelName, curatedImageModelsForProvider } from '@/common/config/imageModels';

describe('isImageModelName', () => {
  it('matches OpenAI Images family', () => {
    expect(isImageModelName('gpt-image-1.5')).toBe(true);
    expect(isImageModelName('gpt-image-1')).toBe(true);
    expect(isImageModelName('chatgpt-image-latest')).toBe(true);
    expect(isImageModelName('dall-e-3')).toBe(true);
  });

  it('matches Google + alias image ids', () => {
    expect(isImageModelName('gemini-3-pro-image-preview')).toBe(true);
    expect(isImageModelName('gemini-2.5-flash-image')).toBe(true);
    expect(isImageModelName('imagen-4.0-generate')).toBe(true);
    expect(isImageModelName('nano-banana-pro')).toBe(true);
    expect(isImageModelName('google/gemini-2.5-flash-image')).toBe(true);
  });

  it('does not match text models', () => {
    expect(isImageModelName('gpt-5')).toBe(false);
    expect(isImageModelName('claude-opus-4')).toBe(false);
    expect(isImageModelName('flux-auto')).toBe(false);
    expect(isImageModelName('gemini-3-pro')).toBe(false);
  });
});

describe('curatedImageModelsForProvider', () => {
  it('returns the OpenAI floor for the native OpenAI platform', () => {
    expect(curatedImageModelsForProvider({ platform: 'openai' })).toEqual([
      'gpt-image-1.5',
      'gpt-image-1',
      'chatgpt-image-latest',
    ]);
  });

  it('matches OpenAI by Images API host even when platform is openai-compatible', () => {
    expect(
      curatedImageModelsForProvider({ platform: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })
    ).toEqual(['gpt-image-1.5', 'gpt-image-1', 'chatgpt-image-latest']);
  });

  it('returns the Gemini floor (nano-banana-pro first) for native Gemini', () => {
    expect(curatedImageModelsForProvider({ platform: 'gemini' })).toEqual([
      'gemini-3-pro-image-preview',
      'gemini-2.5-flash-image',
    ]);
  });

  it('returns vendor-prefixed ids for OpenRouter regardless of platform string', () => {
    expect(curatedImageModelsForProvider({ platform: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' })).toEqual([
      'google/gemini-3-pro-image-preview',
      'google/gemini-2.5-flash-image',
      'openai/gpt-image-1.5',
    ]);
  });

  it('checks host before platform so an openai-compatible OpenRouter row gets OpenRouter ids', () => {
    expect(
      curatedImageModelsForProvider({ platform: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' })
    ).toEqual(['google/gemini-3-pro-image-preview', 'google/gemini-2.5-flash-image', 'openai/gpt-image-1.5']);
  });

  it('returns an empty floor for unknown providers', () => {
    expect(curatedImageModelsForProvider({ platform: 'mystery', baseUrl: 'https://example.com' })).toEqual([]);
    expect(curatedImageModelsForProvider({})).toEqual([]);
  });
});
