/**
 * Unit tests for readConstitutionWithOverlay — the Constitution +
 * per-specialist overlay reader. fs and electron are fully mocked
 * so no real ~/.wayland/ is touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';

// Hoist fs mock so it can be referenced inside vi.mock factory.
const { fsMock } = vi.hoisted(() => ({
  fsMock: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('fs', () => ({
  existsSync: fsMock.existsSync,
  readFileSync: fsMock.readFileSync,
  mkdirSync: fsMock.mkdirSync,
  writeFileSync: fsMock.writeFileSync,
  renameSync: fsMock.renameSync,
  unlinkSync: fsMock.unlinkSync,
}));

// Path constants — must mirror the bridge's resolution logic.
const HOME = homedir();
const WAYLAND_DIR = join(HOME, '.wayland');
const CONSTITUTION_PATH = join(WAYLAND_DIR, 'CONSTITUTION.md');
const LEGACY_SOUL_PATH = join(WAYLAND_DIR, 'SOUL.md');
const SPECIALISTS_DIR = join(WAYLAND_DIR, 'specialists');

const overlayPathFor = (id: string): string => join(SPECIALISTS_DIR, `${id}.md`);

describe('readConstitutionWithOverlay', () => {
  beforeEach(() => {
    vi.resetModules();
    fsMock.existsSync.mockReset();
    fsMock.readFileSync.mockReset();
    fsMock.mkdirSync.mockReset();
    fsMock.writeFileSync.mockReset();
    fsMock.renameSync.mockReset();
    fsMock.unlinkSync.mockReset();
  });

  it('returns empty constitution and null overlay when no files exist', async () => {
    // No CONSTITUTION.md, no SOUL.md, no overlay (assistantId omitted).
    fsMock.existsSync.mockReturnValue(false);

    const { readConstitutionWithOverlay } = await import('@process/bridge/constitutionBridge');
    const result = readConstitutionWithOverlay();

    // Bridge's `readConstitution` returns '' (no auto-seed of DEFAULT_CONSTITUTION on read;
    // that path only fires through writeConstitution/resetConstitution).
    expect(result).toEqual({ constitution: '', overlay: null });
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });

  it('returns CONSTITUTION.md contents and null overlay when assistantId is omitted', async () => {
    const body = '# Live Constitution\nUser-edited content.';
    fsMock.existsSync.mockImplementation((p) => p === CONSTITUTION_PATH);
    fsMock.readFileSync.mockImplementation((p) => {
      if (p === CONSTITUTION_PATH) return body;
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });

    const { readConstitutionWithOverlay } = await import('@process/bridge/constitutionBridge');
    const result = readConstitutionWithOverlay();

    expect(result).toEqual({ constitution: body, overlay: null });
  });

  it('returns null overlay when assistantId is set but no overlay file exists', async () => {
    const body = 'CONSTITUTION_BODY';
    fsMock.existsSync.mockImplementation((p) => p === CONSTITUTION_PATH);
    fsMock.readFileSync.mockImplementation((p) => {
      if (p === CONSTITUTION_PATH) return body;
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });

    const { readConstitutionWithOverlay } = await import('@process/bridge/constitutionBridge');
    const result = readConstitutionWithOverlay('foo');

    expect(result).toEqual({ constitution: body, overlay: null });
    // The bridge MUST have checked for the overlay path.
    expect(fsMock.existsSync).toHaveBeenCalledWith(overlayPathFor('foo'));
  });

  it('returns overlay contents when ~/.wayland/specialists/<id>.md exists', async () => {
    const body = 'CONSTITUTION_BODY';
    const overlayBody = 'OVERLAY_BODY for foo';
    const overlayPath = overlayPathFor('foo');
    fsMock.existsSync.mockImplementation((p) => p === CONSTITUTION_PATH || p === overlayPath);
    fsMock.readFileSync.mockImplementation((p) => {
      if (p === CONSTITUTION_PATH) return body;
      if (p === overlayPath) return overlayBody;
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });

    const { readConstitutionWithOverlay } = await import('@process/bridge/constitutionBridge');
    const result = readConstitutionWithOverlay('foo');

    expect(result).toEqual({ constitution: body, overlay: overlayBody });
  });

  it('falls back to legacy ~/.wayland/SOUL.md when CONSTITUTION.md is missing', async () => {
    const legacyBody = 'legacy SOUL.md body';
    fsMock.existsSync.mockImplementation((p) => p === LEGACY_SOUL_PATH);
    fsMock.readFileSync.mockImplementation((p) => {
      if (p === LEGACY_SOUL_PATH) return legacyBody;
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });

    const { readConstitutionWithOverlay } = await import('@process/bridge/constitutionBridge');
    const result = readConstitutionWithOverlay();

    expect(result).toEqual({ constitution: legacyBody, overlay: null });
  });

  it('blocks path-traversal assistantIds without calling existsSync on the dangerous path', async () => {
    const body = 'CONSTITUTION_BODY';
    fsMock.existsSync.mockImplementation((p) => p === CONSTITUTION_PATH);
    fsMock.readFileSync.mockImplementation((p) => {
      if (p === CONSTITUTION_PATH) return body;
      throw new Error(`unexpected readFileSync: ${String(p)}`);
    });

    const { readConstitutionWithOverlay } = await import('@process/bridge/constitutionBridge');

    const dangerousIds = ['../etc/passwd', 'a/b', '', 'foo bar', '..', './foo', 'foo/../bar'];

    for (const id of dangerousIds) {
      fsMock.existsSync.mockClear();
      fsMock.readFileSync.mockClear();
      // Reset implementations after mockClear (mockClear keeps impl, but
      // be explicit so reads of CONSTITUTION_PATH still return body).
      fsMock.existsSync.mockImplementation((p) => p === CONSTITUTION_PATH);
      fsMock.readFileSync.mockImplementation((p) => {
        if (p === CONSTITUTION_PATH) return body;
        throw new Error(`unexpected readFileSync: ${String(p)}`);
      });

      const result = readConstitutionWithOverlay(id);
      expect(result.overlay).toBeNull();
      expect(result.constitution).toBe(body);

      // existsSync MUST NOT have been called with a path containing
      // the dangerous input — the regex gate short-circuits before
      // we ever construct an overlay path.
      for (const call of fsMock.existsSync.mock.calls) {
        const calledPath = String(call[0]);
        // CONSTITUTION_PATH and LEGACY_SOUL_PATH are the only legitimate
        // existsSync calls; the dangerous id must not appear anywhere.
        expect(calledPath.includes(id) && id.length > 0).toBe(false);
        // Also assert the overlay path was not probed.
        expect(calledPath).not.toContain('specialists');
      }
    }
  });
});
