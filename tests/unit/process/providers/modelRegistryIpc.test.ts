/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the `modelRegistry` IPC handlers (Packet 1F).
 *
 * The handlers are tested through the `createModelRegistryHandlers` factory,
 * which takes every backend collaborator (the 1A–1E modules + the repository)
 * as an injected dependency. Each dependency is a hand-built fake so the tests
 * verify real handler behavior — credential resolution, catalog assembly,
 * override application, defensive error handling — without any network, disk,
 * or database I/O.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real-DB round-trip exercises `ProviderRepository`, which encrypts
// model-registry creds through Electron `safeStorage`. Electron's runtime and
// OS keychain are not available under Vitest, so stub `safeStorage` with an
// in-memory codec that mirrors its prefix/base64 contract.
const { mockSafeStorage } = vi.hoisted(() => ({
  mockSafeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((plaintext: string) => Buffer.from(`enc(${plaintext})`)),
    decryptString: vi.fn((cipher: Buffer) => {
      const raw = cipher.toString('utf8');
      const match = raw.match(/^enc\((.*)\)$/s);
      if (!match) throw new Error('decrypt failed');
      return match[1];
    }),
  },
}));

vi.mock('electron', () => ({ safeStorage: mockSafeStorage }));

import { createModelRegistryHandlers } from '@process/providers/ipc/modelRegistryIpc';
import type { ModelRegistryDeps } from '@process/providers/ipc/modelRegistryIpc';
import type { CatalogModel, ProviderId } from '@process/providers/types';
import { ProviderRepository } from '@process/providers/storage/ProviderRepository';
import type {
  RegistryCredsResult,
  RegistryOverride,
  RegistryProvider,
} from '@process/providers/storage/ProviderRepository';
import type { DiscoveredKey } from '@process/providers/detection/KeyDiscovery';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import { CURRENT_DB_VERSION, initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function catalogModel(over: Partial<CatalogModel> & { id: string; providerId: ProviderId }): CatalogModel {
  return {
    displayName: over.id,
    family: over.id,
    kind: 'text',
    enriched: false,
    ...over,
  };
}

// ─── In-memory repository fake ────────────────────────────────────────────────

/** A minimal in-memory stand-in for the model-registry slice of the repo. */
class FakeRepo {
  providers = new Map<ProviderId, RegistryProvider & { creds: Record<string, unknown> }>();
  catalogs = new Map<ProviderId, CatalogModel[]>();
  overrides = new Map<ProviderId, RegistryOverride[]>();

  listRegistryProviders(): RegistryProvider[] {
    return [...this.providers.values()];
  }

  getRegistryProvider(id: ProviderId): RegistryProvider | null {
    return this.providers.get(id) ?? null;
  }

  upsertRegistryProvider(p: {
    providerId: ProviderId;
    connectedVia: string;
    state: RegistryProvider['state'];
    error?: RegistryProvider['error'];
    creds: Record<string, unknown>;
  }): void {
    const row: RegistryProvider & { creds: Record<string, unknown> } = {
      providerId: p.providerId,
      connectedVia: p.connectedVia,
      state: p.state,
      credsEncrypted: 'enc',
      creds: p.creds,
    };
    if (p.error) row.error = p.error;
    this.providers.set(p.providerId, row);
  }

  updateRegistryProviderState(
    id: ProviderId,
    state: RegistryProvider['state'],
    error?: RegistryProvider['error']
  ): void {
    const row = this.providers.get(id);
    if (!row) return;
    row.state = state;
    if (error) row.error = error;
    else delete row.error;
  }

  updateRegistryProviderCreds(id: ProviderId, creds: Record<string, unknown>): void {
    const row = this.providers.get(id);
    if (row) row.creds = creds;
  }

  getRegistryProviderCreds(id: ProviderId): RegistryCredsResult {
    const creds = this.providers.get(id)?.creds;
    return creds ? { status: 'ok', creds } : { status: 'not-found' };
  }

  deleteRegistryProvider(id: ProviderId): void {
    this.providers.delete(id);
    this.catalogs.delete(id);
    this.overrides.delete(id);
  }

  replaceRegistryCatalog(id: ProviderId, models: CatalogModel[]): void {
    this.catalogs.set(id, models);
  }

  getRegistryCatalog(id: ProviderId): CatalogModel[] {
    return this.catalogs.get(id) ?? [];
  }

  countRegistryCatalog(id: ProviderId): number {
    return (this.catalogs.get(id) ?? []).length;
  }

  setRegistryOverride(id: ProviderId, modelId: string, enabled: boolean): void {
    const list = this.overrides.get(id) ?? [];
    const existing = list.find((o) => o.modelId === modelId);
    if (existing) existing.enabled = enabled;
    else list.push({ modelId, enabled });
    this.overrides.set(id, list);
  }

  listRegistryOverrides(id: ProviderId): RegistryOverride[] {
    return this.overrides.get(id) ?? [];
  }
}

// ─── Dependency builder ───────────────────────────────────────────────────────

type Fakes = {
  repo: FakeRepo;
  deps: ModelRegistryDeps;
  scan: ReturnType<typeof vi.fn>;
  readValue: ReturnType<typeof vi.fn>;
  test: ReturnType<typeof vi.fn>;
  getRegistry: ReturnType<typeof vi.fn>;
  apiListModels: ReturnType<typeof vi.fn>;
  cliListModels: ReturnType<typeof vi.fn>;
};

function makeFakes(over: Partial<{ apiModels: unknown; testResult: unknown }> = {}): Fakes {
  const repo = new FakeRepo();

  const scan = vi.fn<() => Promise<DiscoveredKey[]>>().mockResolvedValue([]);
  const readValue = vi.fn<(d: DiscoveredKey) => string | null>().mockReturnValue(null);
  const test = vi.fn().mockResolvedValue(over.testResult ?? { ok: true });
  const getRegistry = vi.fn().mockResolvedValue({});
  const apiListModels = vi.fn().mockResolvedValue(over.apiModels ?? [{ id: 'gpt-4o', providerId: 'openai' }]);
  const cliListModels = vi.fn().mockResolvedValue([{ id: 'gpt-5-codex', providerId: 'openai' }]);

  const deps: ModelRegistryDeps = {
    repo: repo as unknown as ModelRegistryDeps['repo'],
    keyDiscovery: { scan, readValue },
    connectionTester: { test },
    modelsDevClient: { getRegistry },
    makeApiSource: (providerId) => ({ kind: 'api', providerId, listModels: apiListModels }),
    makeCliSource: (agentKey) => ({
      kind: 'cli',
      providerId: agentKey,
      enumerable: agentKey === 'codex',
      underlyingProviderId: agentKey === 'codex' ? 'openai' : agentKey === 'claude' ? 'anthropic' : 'google-gemini',
      listModels: cliListModels,
    }),
  };

  return { repo, deps, scan, readValue, test, getRegistry, apiListModels, cliListModels };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('modelRegistry IPC — detectKeys', () => {
  it('returns the discovered keys verbatim', async () => {
    const { deps, scan } = makeFakes();
    scan.mockResolvedValue([{ providerId: 'openai', source: 'env:OPENAI_API_KEY' }]);
    const h = createModelRegistryHandlers(deps);

    expect(await h.detectKeys()).toEqual([{ providerId: 'openai', source: 'env:OPENAI_API_KEY' }]);
  });

  it('returns an empty list when scan throws', async () => {
    const { deps, scan } = makeFakes();
    scan.mockRejectedValue(new Error('boom'));
    const h = createModelRegistryHandlers(deps);

    expect(await h.detectKeys()).toEqual([]);
  });
});

describe('modelRegistry IPC — connect', () => {
  it('connects a standard provider, persists it, and builds the catalog', async () => {
    const { deps, repo, test } = makeFakes();
    const h = createModelRegistryHandlers(deps);

    const result = await h.connect({ providerId: 'openai', creds: { key: 'sk-test' } });

    expect(result).toEqual({ ok: true });
    expect(test).toHaveBeenCalledWith('openai', { key: 'sk-test' });
    expect(repo.getRegistryProvider('openai')?.state).toBe('connected');
    expect(repo.getRegistryProviderCreds('openai')).toEqual({ status: 'ok', creds: { key: 'sk-test' } });
    expect(repo.getRegistryCatalog('openai').map((m) => m.id)).toEqual(['gpt-4o']);
  });

  it('returns the ConnectError and does not persist when the test fails', async () => {
    const { deps, repo } = makeFakes({ testResult: { ok: false, error: 'unauthorized' } });
    const h = createModelRegistryHandlers(deps);

    const result = await h.connect({ providerId: 'openai', creds: { key: 'sk-bad' } });

    expect(result).toEqual({ ok: false, error: 'unauthorized' });
    expect(repo.getRegistryProvider('openai')).toBeNull();
  });

  it('resolves a useDiscovered credential to a real key before testing', async () => {
    const { deps, scan, readValue, test } = makeFakes();
    scan.mockResolvedValue([{ providerId: 'anthropic', source: 'env:ANTHROPIC_API_KEY' }]);
    readValue.mockReturnValue('sk-ant-resolved');
    const h = createModelRegistryHandlers(deps);

    const result = await h.connect({ providerId: 'anthropic', creds: { useDiscovered: true } });

    expect(result).toEqual({ ok: true });
    expect(test).toHaveBeenCalledWith('anthropic', { key: 'sk-ant-resolved' });
  });

  it('fails with unrecognized when useDiscovered finds no key', async () => {
    const { deps } = makeFakes();
    const h = createModelRegistryHandlers(deps);

    const result = await h.connect({ providerId: 'openai', creds: { useDiscovered: true } });

    expect(result).toEqual({ ok: false, error: 'unrecognized' });
  });

  it('connects a cloud provider without an inference test and builds from the registry', async () => {
    const { deps, repo, test } = makeFakes();
    deps.modelsDevClient.getRegistry = vi.fn().mockResolvedValue({
      'amazon-bedrock': {
        id: 'amazon-bedrock',
        name: 'Amazon Bedrock',
        env: [],
        models: {
          'claude-3-5-sonnet': { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
        },
      },
    });
    const h = createModelRegistryHandlers(deps);

    const result = await h.connect({
      providerId: 'aws-bedrock',
      creds: { fields: { accessKeyId: 'AK', secretAccessKey: 'SK', region: 'us-east-1' } },
    });

    expect(result).toEqual({ ok: true });
    // The cloud path must NOT gate the connect on a HTTP probe.
    expect(test).not.toHaveBeenCalled();
    expect(repo.getRegistryProvider('aws-bedrock')?.state).toBe('connected');
    expect(repo.getRegistryCatalog('aws-bedrock').map((m) => m.id)).toEqual(['claude-3-5-sonnet']);
  });

  it('marks the provider in error state when the catalog persist throws', async () => {
    const { deps, repo } = makeFakes();
    // Simulate a failing DB write inside buildAndPersistCatalog.
    repo.replaceRegistryCatalog = () => {
      throw new Error('disk full');
    };
    const h = createModelRegistryHandlers(deps);

    const result = await h.connect({ providerId: 'openai', creds: { key: 'sk-test' } });

    // The connect must report failure, not a false {ok:true}.
    expect(result).toEqual({ ok: false, error: 'unknown' });
    // And the persisted provider must NOT be a false green — it is `'error'`.
    expect(repo.getRegistryProvider('openai')?.state).toBe('error');
    expect(repo.getRegistryProvider('openai')?.error).toBe('unknown');
  });
});

describe('modelRegistry IPC — testConnection', () => {
  it('tests stored credentials and reflects success', async () => {
    const { deps, repo, test } = makeFakes();
    repo.upsertRegistryProvider({
      providerId: 'openai',
      connectedVia: 'api-key',
      state: 'error',
      creds: { key: 'sk-stored' },
    });
    const h = createModelRegistryHandlers(deps);

    const result = await h.testConnection({ providerId: 'openai' });

    expect(result).toEqual({ ok: true });
    expect(test).toHaveBeenCalledWith('openai', { key: 'sk-stored' });
    expect(repo.getRegistryProvider('openai')?.state).toBe('connected');
  });

  it('marks the provider in error state on a failed test', async () => {
    const { deps, repo } = makeFakes({ testResult: { ok: false, error: 'no-credit' } });
    repo.upsertRegistryProvider({
      providerId: 'openai',
      connectedVia: 'api-key',
      state: 'connected',
      creds: { key: 'sk-stored' },
    });
    const h = createModelRegistryHandlers(deps);

    const result = await h.testConnection({ providerId: 'openai' });

    expect(result).toEqual({ ok: false, error: 'no-credit' });
    expect(repo.getRegistryProvider('openai')?.state).toBe('error');
  });

  it('returns unrecognized when the provider is not connected', async () => {
    const { deps } = makeFakes();
    const h = createModelRegistryHandlers(deps);

    expect(await h.testConnection({ providerId: 'openai' })).toEqual({ ok: false, error: 'unrecognized' });
  });
});

describe('modelRegistry IPC — list', () => {
  it('returns a view row per connected provider with model counts', async () => {
    const { deps, repo } = makeFakes();
    repo.upsertRegistryProvider({
      providerId: 'openai',
      connectedVia: 'api-key',
      state: 'connected',
      creds: { key: 'k' },
    });
    repo.replaceRegistryCatalog('openai', [
      catalogModel({ id: 'gpt-4o', providerId: 'openai' }),
      catalogModel({ id: 'gpt-4o-mini', providerId: 'openai' }),
    ]);
    const h = createModelRegistryHandlers(deps);

    expect(await h.list()).toEqual([
      { providerId: 'openai', connectedVia: 'api-key', state: 'connected', modelCount: 2 },
    ]);
  });

  it('returns an empty list when nothing is connected', async () => {
    const { deps } = makeFakes();
    const h = createModelRegistryHandlers(deps);
    expect(await h.list()).toEqual([]);
  });
});

describe('modelRegistry IPC — getCatalog', () => {
  it('returns the catalog + curated view and applies a toggle override', async () => {
    const { deps, repo } = makeFakes();
    repo.upsertRegistryProvider({
      providerId: 'openai',
      connectedVia: 'api-key',
      state: 'connected',
      creds: { key: 'k' },
    });
    // Two models in one family — the Curator enables both (flagship + previous).
    repo.replaceRegistryCatalog('openai', [
      catalogModel({ id: 'gpt-4o', providerId: 'openai', family: 'gpt-4o', releaseDate: '2024-05-01' }),
      catalogModel({ id: 'gpt-4o-old', providerId: 'openai', family: 'gpt-4o', releaseDate: '2024-01-01' }),
    ]);
    // The user explicitly disabled the flagship.
    repo.setRegistryOverride('openai', 'gpt-4o', false);
    const h = createModelRegistryHandlers(deps);

    const { catalog, curated } = await h.getCatalog({ providerId: 'openai' });

    expect(catalog).toHaveLength(2);
    const flagship = curated.find((m) => m.id === 'gpt-4o');
    expect(flagship?.enabled).toBe(false); // override flipped it off
    const previous = curated.find((m) => m.id === 'gpt-4o-old');
    expect(previous?.enabled).toBe(true); // untouched — stays curated-enabled
  });

  it('returns empty views for an unknown provider', async () => {
    const { deps } = makeFakes();
    const h = createModelRegistryHandlers(deps);
    expect(await h.getCatalog({ providerId: 'openai' })).toEqual({ catalog: [], curated: [] });
  });
});

describe('modelRegistry IPC — toggleModel', () => {
  it('persists the override', async () => {
    const { deps, repo } = makeFakes();
    const h = createModelRegistryHandlers(deps);

    const result = await h.toggleModel({ providerId: 'openai', modelId: 'gpt-4o', enabled: false });

    expect(result).toEqual({ ok: true });
    expect(repo.listRegistryOverrides('openai')).toEqual([{ modelId: 'gpt-4o', enabled: false }]);
  });
});

describe('modelRegistry IPC — refresh', () => {
  it('re-assembles and re-persists the catalog', async () => {
    const { deps, repo, apiListModels } = makeFakes();
    repo.upsertRegistryProvider({
      providerId: 'openai',
      connectedVia: 'api-key',
      state: 'connected',
      creds: { key: 'k' },
    });
    repo.replaceRegistryCatalog('openai', [catalogModel({ id: 'old-model', providerId: 'openai' })]);
    apiListModels.mockResolvedValue([{ id: 'gpt-4o-new', providerId: 'openai' }]);
    const h = createModelRegistryHandlers(deps);

    const result = await h.refresh({ providerId: 'openai' });

    expect(result).toEqual({ ok: true });
    expect(repo.getRegistryCatalog('openai').map((m) => m.id)).toEqual(['gpt-4o-new']);
  });

  it('returns ok:false when the provider is not connected', async () => {
    const { deps } = makeFakes();
    const h = createModelRegistryHandlers(deps);
    expect(await h.refresh({ providerId: 'openai' })).toEqual({ ok: false });
  });
});

describe('modelRegistry IPC — disconnect', () => {
  it('removes the provider, its catalog, and its overrides', async () => {
    const { deps, repo } = makeFakes();
    repo.upsertRegistryProvider({
      providerId: 'openai',
      connectedVia: 'api-key',
      state: 'connected',
      creds: { key: 'k' },
    });
    repo.replaceRegistryCatalog('openai', [catalogModel({ id: 'gpt-4o', providerId: 'openai' })]);
    repo.setRegistryOverride('openai', 'gpt-4o', false);
    const h = createModelRegistryHandlers(deps);

    const result = await h.disconnect({ providerId: 'openai' });

    expect(result).toEqual({ ok: true });
    expect(repo.getRegistryProvider('openai')).toBeNull();
    expect(repo.getRegistryCatalog('openai')).toEqual([]);
    expect(repo.listRegistryOverrides('openai')).toEqual([]);
  });
});

describe('modelRegistry IPC — rekey', () => {
  it('replaces the credentials and re-assembles on success', async () => {
    const { deps, repo, test } = makeFakes();
    repo.upsertRegistryProvider({
      providerId: 'openai',
      connectedVia: 'api-key',
      state: 'error',
      creds: { key: 'sk-old' },
    });
    const h = createModelRegistryHandlers(deps);

    const result = await h.rekey({ providerId: 'openai', creds: { key: 'sk-new' } });

    expect(result).toEqual({ ok: true });
    expect(test).toHaveBeenCalledWith('openai', { key: 'sk-new' });
    expect(repo.getRegistryProviderCreds('openai')).toEqual({ status: 'ok', creds: { key: 'sk-new' } });
    expect(repo.getRegistryProvider('openai')?.state).toBe('connected');
  });

  it('keeps the old credentials when the new key fails', async () => {
    const { deps, repo } = makeFakes({ testResult: { ok: false, error: 'unauthorized' } });
    repo.upsertRegistryProvider({
      providerId: 'openai',
      connectedVia: 'api-key',
      state: 'connected',
      creds: { key: 'sk-old' },
    });
    const h = createModelRegistryHandlers(deps);

    const result = await h.rekey({ providerId: 'openai', creds: { key: 'sk-bad' } });

    expect(result).toEqual({ ok: false, error: 'unauthorized' });
    expect(repo.getRegistryProviderCreds('openai')).toEqual({ status: 'ok', creds: { key: 'sk-old' } });
  });
});

describe('modelRegistry IPC — curatedForAgent', () => {
  it('unions every connected provider for the wcore agent', async () => {
    const { deps, repo } = makeFakes();
    repo.upsertRegistryProvider({
      providerId: 'openai',
      connectedVia: 'api-key',
      state: 'connected',
      creds: { key: 'k' },
    });
    repo.upsertRegistryProvider({
      providerId: 'anthropic',
      connectedVia: 'api-key',
      state: 'connected',
      creds: { key: 'k' },
    });
    repo.replaceRegistryCatalog('openai', [catalogModel({ id: 'gpt-4o', providerId: 'openai' })]);
    repo.replaceRegistryCatalog('anthropic', [catalogModel({ id: 'claude-3-5', providerId: 'anthropic' })]);
    const h = createModelRegistryHandlers(deps);

    const curated = await h.curatedForAgent({ agentKey: 'wcore' });

    expect(curated.map((m) => m.id).toSorted()).toEqual(['claude-3-5', 'gpt-4o']);
  });

  it('builds an enumerable CLI agent (codex) from its CLI source', async () => {
    const { deps, cliListModels } = makeFakes();
    cliListModels.mockResolvedValue([{ id: 'gpt-5-codex', providerId: 'openai' }]);
    const h = createModelRegistryHandlers(deps);

    const curated = await h.curatedForAgent({ agentKey: 'codex' });

    expect(curated.map((m) => m.id)).toEqual(['gpt-5-codex']);
  });

  it('falls back to the underlying provider for a non-enumerable CLI agent', async () => {
    const { deps, repo } = makeFakes();
    repo.upsertRegistryProvider({
      providerId: 'anthropic',
      connectedVia: 'api-key',
      state: 'connected',
      creds: { key: 'k' },
    });
    repo.replaceRegistryCatalog('anthropic', [catalogModel({ id: 'claude-3-5', providerId: 'anthropic' })]);
    const h = createModelRegistryHandlers(deps);

    const curated = await h.curatedForAgent({ agentKey: 'claude' });

    expect(curated.map((m) => m.id)).toEqual(['claude-3-5']);
  });

  it('returns [] for a non-enumerable CLI agent whose provider is not connected', async () => {
    const { deps } = makeFakes();
    const h = createModelRegistryHandlers(deps);

    expect(await h.curatedForAgent({ agentKey: 'gemini' })).toEqual([]);
  });

  it('returns [] for an unknown agent key', async () => {
    const { deps } = makeFakes();
    const h = createModelRegistryHandlers(deps);
    expect(await h.curatedForAgent({ agentKey: 'nonsense' })).toEqual([]);
  });
});

describe('modelRegistry IPC — defensive behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('connect never throws — a thrown collaborator yields a typed failure', async () => {
    const { deps } = makeFakes();
    deps.connectionTester.test = vi.fn().mockRejectedValue(new Error('network exploded'));
    const h = createModelRegistryHandlers(deps);

    const result = await h.connect({ providerId: 'openai', creds: { key: 'sk' } });

    expect(result).toEqual({ ok: false, error: 'unknown' });
  });

  it('does not return credential material in the list view', async () => {
    const { deps, repo } = makeFakes();
    repo.upsertRegistryProvider({
      providerId: 'openai',
      connectedVia: 'api-key',
      state: 'connected',
      creds: { key: 'sk-secret-value' },
    });
    const h = createModelRegistryHandlers(deps);

    const serialized = JSON.stringify(await h.list());
    expect(serialized).not.toContain('sk-secret-value');
  });

  it('curatedForAgent yields [] when assembly throws', async () => {
    const { deps } = makeFakes();
    deps.modelsDevClient.getRegistry = vi.fn().mockRejectedValue(new Error('registry down'));
    deps.makeCliSource = () => {
      throw new Error('cli source exploded');
    };
    const h = createModelRegistryHandlers(deps);

    expect(await h.curatedForAgent({ agentKey: 'codex' })).toEqual([]);
  });
});

// ─── Real-repository credential encryption round-trip ─────────────────────────

// `better-sqlite3` is a native module — skip these when its ABI does not match
// the test runner (the same guard the team-repository round-trip tests use).
let nativeSqliteAvailable = true;
try {
  const probe = new BetterSqlite3Driver(':memory:');
  probe.close();
} catch (e) {
  if (e instanceof Error && e.message.includes('NODE_MODULE_VERSION')) {
    nativeSqliteAvailable = false;
  }
}

const describeOrSkip = nativeSqliteAvailable ? describe : describe.skip;

describeOrSkip('ProviderRepository — registry credential encryption round-trip', () => {
  let driver: BetterSqlite3Driver;
  let repo: ProviderRepository;

  beforeEach(() => {
    driver = new BetterSqlite3Driver(':memory:');
    initSchema(driver);
    runMigrations(driver, 0, CURRENT_DB_VERSION);
    repo = new ProviderRepository(driver);
  });

  afterEach(() => {
    driver.close();
  });

  it('encrypts creds at rest and decrypts them back to the original', () => {
    const creds = { key: 'sk-super-secret-plaintext-value' };
    repo.upsertRegistryProvider({
      providerId: 'openai',
      connectedVia: 'api-key',
      state: 'connected',
      creds,
    });

    // The decrypted creds must equal the original object.
    expect(repo.getRegistryProviderCreds('openai')).toEqual({ status: 'ok', creds });

    // The stored ciphertext column must NOT contain the plaintext, and must
    // carry the safeStorage `enc:v1:` prefix.
    const row = driver
      .prepare(`SELECT creds_encrypted FROM model_registry_providers WHERE provider_id = ?`)
      .get('openai') as { creds_encrypted: string };
    expect(row.creds_encrypted).not.toContain('sk-super-secret-plaintext-value');
    expect(row.creds_encrypted.startsWith('enc:v1:')).toBe(true);
  });

  it('re-encrypts on updateRegistryProviderCreds and still round-trips', () => {
    repo.upsertRegistryProvider({
      providerId: 'anthropic',
      connectedVia: 'api-key',
      state: 'connected',
      creds: { key: 'sk-ant-old' },
    });

    const rekeyed = { key: 'sk-ant-rotated-secret' };
    repo.updateRegistryProviderCreds('anthropic', rekeyed);

    expect(repo.getRegistryProviderCreds('anthropic')).toEqual({ status: 'ok', creds: rekeyed });
    const row = driver
      .prepare(`SELECT creds_encrypted FROM model_registry_providers WHERE provider_id = ?`)
      .get('anthropic') as { creds_encrypted: string };
    expect(row.creds_encrypted).not.toContain('sk-ant-rotated-secret');
  });

  it('returns status "not-found" for a provider that was never connected', () => {
    expect(repo.getRegistryProviderCreds('openai')).toEqual({ status: 'not-found' });
  });

  it('returns status "undecryptable" when the stored ciphertext is corrupt', () => {
    repo.upsertRegistryProvider({
      providerId: 'openai',
      connectedVia: 'api-key',
      state: 'connected',
      creds: { key: 'sk-original' },
    });

    // Simulate creds that became unreadable (OS keychain rotation, corruption).
    driver
      .prepare(`UPDATE model_registry_providers SET creds_encrypted = ? WHERE provider_id = ?`)
      .run('enc:v1:not-valid-ciphertext', 'openai');

    // The provider row still exists — the result must distinguish this from
    // "not connected" so a follow-up can surface a re-key path.
    expect(repo.getRegistryProvider('openai')).not.toBeNull();
    expect(repo.getRegistryProviderCreds('openai')).toEqual({ status: 'undecryptable' });
  });

  it('deleteRegistryProvider cascades to catalog and overrides via the FK', () => {
    repo.upsertRegistryProvider({
      providerId: 'openai',
      connectedVia: 'api-key',
      state: 'connected',
      creds: { key: 'k' },
    });
    repo.replaceRegistryCatalog('openai', [
      catalogModel({ id: 'gpt-4o', providerId: 'openai' }),
      catalogModel({ id: 'gpt-4o-mini', providerId: 'openai' }),
    ]);
    repo.setRegistryOverride('openai', 'gpt-4o', false);

    repo.deleteRegistryProvider('openai');

    // The single provider delete must leave no orphaned child rows.
    expect(repo.getRegistryProvider('openai')).toBeNull();
    expect(repo.getRegistryCatalog('openai')).toEqual([]);
    expect(repo.listRegistryOverrides('openai')).toEqual([]);
    const catalogCount = driver
      .prepare(`SELECT COUNT(*) AS n FROM model_registry_catalog WHERE provider_id = ?`)
      .get('openai') as { n: number };
    const overrideCount = driver
      .prepare(`SELECT COUNT(*) AS n FROM model_registry_overrides WHERE provider_id = ?`)
      .get('openai') as { n: number };
    expect(catalogCount.n).toBe(0);
    expect(overrideCount.n).toBe(0);
  });

  it('countRegistryCatalog returns the persisted model count without parsing blobs', () => {
    repo.upsertRegistryProvider({
      providerId: 'openai',
      connectedVia: 'api-key',
      state: 'connected',
      creds: { key: 'k' },
    });
    repo.replaceRegistryCatalog('openai', [
      catalogModel({ id: 'gpt-4o', providerId: 'openai' }),
      catalogModel({ id: 'gpt-4o-mini', providerId: 'openai' }),
      catalogModel({ id: 'o3', providerId: 'openai' }),
    ]);

    expect(repo.countRegistryCatalog('openai')).toBe(3);
    expect(repo.countRegistryCatalog('anthropic')).toBe(0);
  });
});
