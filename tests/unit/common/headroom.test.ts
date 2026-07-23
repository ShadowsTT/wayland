import { describe, it, expect } from 'vitest';
import {
  HEADROOM_DEFAULT_ENDPOINT,
  isHeadroomRoutableBackend,
  isValidHeadroomEndpoint,
  resolveHeadroomEndpoint,
} from '@/common/config/headroom';

describe('headroom constants', () => {
  it('pins the default local proxy endpoint', () => {
    expect(HEADROOM_DEFAULT_ENDPOINT).toBe('http://127.0.0.1:8787');
  });
});

describe('isHeadroomRoutableBackend', () => {
  it('routes only Anthropic-wire backends (claude)', () => {
    expect(isHeadroomRoutableBackend('claude')).toBe(true);
  });

  it('never routes OpenAI/Gemini-surface backends', () => {
    for (const backend of ['codex', 'qwen', 'gemini', 'goose', 'hermes']) {
      expect(isHeadroomRoutableBackend(backend)).toBe(false);
    }
  });
});

describe('resolveHeadroomEndpoint', () => {
  it('falls back to the default when unset or blank', () => {
    expect(resolveHeadroomEndpoint(undefined)).toBe(HEADROOM_DEFAULT_ENDPOINT);
    expect(resolveHeadroomEndpoint(null)).toBe(HEADROOM_DEFAULT_ENDPOINT);
    expect(resolveHeadroomEndpoint('   ')).toBe(HEADROOM_DEFAULT_ENDPOINT);
  });

  it('honors a configured endpoint and trims trailing slashes', () => {
    expect(resolveHeadroomEndpoint('http://localhost:9000')).toBe('http://localhost:9000');
    expect(resolveHeadroomEndpoint('http://localhost:9000/')).toBe('http://localhost:9000');
    expect(resolveHeadroomEndpoint('  http://localhost:9000//  ')).toBe('http://localhost:9000');
  });
});

describe('isValidHeadroomEndpoint', () => {
  it('accepts http(s) URLs', () => {
    expect(isValidHeadroomEndpoint('http://127.0.0.1:8787')).toBe(true);
    expect(isValidHeadroomEndpoint('https://headroom.local')).toBe(true);
  });

  it('rejects blanks and non-http schemes', () => {
    expect(isValidHeadroomEndpoint('')).toBe(false);
    expect(isValidHeadroomEndpoint('   ')).toBe(false);
    expect(isValidHeadroomEndpoint('ftp://x')).toBe(false);
    expect(isValidHeadroomEndpoint('not a url')).toBe(false);
  });
});
