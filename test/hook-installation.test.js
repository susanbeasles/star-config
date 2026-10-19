import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  lstatSync: vi.fn(),
}));
vi.mock('../src/managed-files.js', () => ({ readManaged: vi.fn(), writeManaged: vi.fn() }));
vi.mock('../src/runner.js', () => ({
  exec: vi.fn(() => 0),
  log: vi.fn(),
  bold: (x) => x,
  dim: (x) => x,
  green: (x) => x,
  yellow: (x) => x,
}));
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, writeFileSync } from 'node:fs';
import { readManaged } from '../src/managed-files.js';
import { GUARD, HOOKS, validateHostPath } from '../src/hook-boundary.js';
import { exec } from '../src/runner.js';
import { installHooks, setup } from '../src/setup.js';

const safeStat = (directory) => ({
  uid: 0,
  mode: 0o755,
  isSymbolicLink: () => false,
  isDirectory: () => directory,
  isFile: () => !directory,
});
beforeEach(() => {
  vi.clearAllMocks();
  readManaged.mockReturnValue(null);
  spawnSync.mockImplementation((_, args) =>
    args[0] === 'config' ? { status: 1, stdout: '' } : { status: 0, stdout: '.git/hooks\n' },
  );
  existsSync.mockReturnValue(false);
  lstatSync.mockImplementation((p) =>
    safeStat(![GUARD, `${HOOKS}/pre-commit`, `${HOOKS}/pre-push`].includes(p)),
  );
});
const ctx = { root: '/fixture', stacks: { node: {} } };
describe('immutable hook installation', () => {
  it('registers only the fixed host directory without running Husky', () => {
    expect(installHooks(ctx)).toBe(0);
    expect(exec).toHaveBeenCalledWith('git', ['config', '--local', 'core.hooksPath', HOOKS], {
      cwd: '/fixture',
    });
    expect(spawnSync.mock.calls.every((call) => call[0] === 'git')).toBe(true);
  });
  it.each(['.husky', '.husky/_', '/custom/hooks'])(
    'preserves existing %s configuration',
    (existing) => {
      spawnSync.mockReturnValue({ status: 0, stdout: existing });
      expect(() => installHooks(ctx)).toThrow(/preserved/);
      expect(exec).not.toHaveBeenCalled();
    },
  );
  it('preserves hooks in the default Git directory', () => {
    existsSync.mockReturnValue(true);
    readdirSync.mockReturnValue(['pre-commit']);
    expect(() => installHooks(ctx)).toThrow(/preserved/);
    expect(exec).not.toHaveBeenCalled();
  });
  it('fails when the runner is absent', () => {
    lstatSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(() => installHooks(ctx)).toThrow(/no checkout fallback/);
    expect(exec).not.toHaveBeenCalled();
  });
  it.each([
    { uid: 1000 },
    { mode: 0o775 },
    { mode: 0o757 },
    { mode: 0o644 },
    { isSymbolicLink: () => true },
    { isFile: () => false },
  ])('rejects unsafe runner metadata %j', (unsafe) => {
    lstatSync.mockImplementation((p) =>
      p === GUARD ? { ...safeStat(false), ...unsafe } : safeStat(true),
    );
    expect(() => validateHostPath(GUARD)).toThrow(/Unsafe host installation/);
  });
  it('rejects writable parent directories', () => {
    lstatSync.mockImplementation(() => ({ ...safeStat(true), mode: 0o777 }));
    expect(() => validateHostPath(GUARD)).toThrow(/Unsafe host installation/);
  });
  it('rejects a Husky lifecycle installer before setup executes any subprocess', async () => {
    existsSync.mockImplementation((p) => p.endsWith('package.json'));
    readManaged.mockReturnValue(JSON.stringify({ scripts: { prepare: 'husky' } }));
    await expect(setup(ctx, {})).rejects.toThrow(/prepare invokes Husky/);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
  it('rejects an absent host before any setup subprocess or dependency install', async () => {
    lstatSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    await expect(setup(ctx, { install: true })).rejects.toThrow(/no checkout fallback/);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
  it('preserves and rejects a custom Husky prepare script', () => {
    existsSync.mockImplementation((p) => p.endsWith('package.json'));
    readManaged.mockReturnValue(JSON.stringify({ scripts: { prepare: 'build && husky' } }));
    expect(() => installHooks(ctx)).toThrow(/prepare invokes Husky/);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
