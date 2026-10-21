import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { setup, sync } from '../src/commands.js';
import { loadContext, readRepoConfig } from '../src/context.js';
import { npmPackagesToAdd } from '../src/setup.js';
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'star-setup-containment-'));
  dirs.push(dir);
  const root = path.join(dir, 'repo');
  mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  const outside = path.join(dir, 'outside');
  writeFileSync(outside, '{}');
  return { root, outside };
}
it.each(['leaf', 'parent'])(
  'refuses CLI config %s symlinks without modifying external content',
  async (kind) => {
    const { root, outside } = fixture();
    if (kind === 'leaf') {
      mkdirSync(path.join(root, '.star'));
      symlinkSync(outside, path.join(root, '.star/config.json'));
    } else {
      symlinkSync(path.dirname(outside), path.join(root, '.star'));
    }
    await expect(
      setup(root, { owners: ['@synthetic'], install: false, scaffold: false }),
    ).rejects.toThrow(/Unsafe/);
    expect(readFileSync(outside, 'utf8')).toBe('{}');
  },
);
it('rejects linked package manifests before calculating dependencies', () => {
  const { root, outside } = fixture();
  symlinkSync(outside, path.join(root, 'package.json'));
  expect(() => loadContext(root, {}, true)).toThrow(/Unsafe/);
  expect(() => npmPackagesToAdd({ root, stacks: { node: {} } })).toThrow(/Unsafe/);
  expect(readFileSync(outside, 'utf8')).toBe('{}');
});

it('keeps ordinary context reads portable while managed setup reads fail closed', () => {
  const { root } = fixture();
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try {
    expect(readRepoConfig(root)).toEqual({});
    expect(() => readRepoConfig(root, true)).toThrow(/Linux/);
  } finally {
    Object.defineProperty(process, 'platform', { value: platform });
  }
});

it.each([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'pnpmfile.cjs',
  '.pnpmfile.cjs',
  'mise.toml',
  'mise.lock',
])('rejects linked package manager input %s', (name) => {
  const { root, outside } = fixture();
  writeFileSync(path.join(root, 'package.json'), '{}');
  symlinkSync(outside, path.join(root, name));
  expect(() => loadContext(root, {}, true)).toThrow(/Unsafe/);
  expect(() => npmPackagesToAdd({ root, stacks: { node: {} } })).toThrow(/Unsafe/);
  expect(readFileSync(outside, 'utf8')).toBe('{}');
});
it.each(['.star/config.json', 'package.json'])(
  'rejects linked sync input %s at the CLI entry and reload',
  async (name) => {
    const { root, outside } = fixture();
    mkdirSync(path.join(root, '.star'));
    symlinkSync(outside, path.join(root, name));
    const result = spawnSync(
      process.execPath,
      [path.resolve('bin/star-config.js'), 'sync', '--check'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Unsafe/);
    await expect(sync({ root }, { dryRun: true })).rejects.toThrow(/Unsafe/);
    expect(readFileSync(outside, 'utf8')).toBe('{}');
  },
);

it.each([
  'requirements.txt',
  'pyproject.toml',
  'uv.lock',
  'poetry.lock',
  'uv.toml',
  'poetry.toml',
  'setup.py',
  'setup.cfg',
])('rejects linked Python input %s before setup', async (name) => {
  const { root, outside } = fixture();
  writeFileSync(path.join(root, 'main.py'), 'print(1)');
  symlinkSync(outside, path.join(root, name));
  expect(() => loadContext(root, {}, true)).toThrow(/Unsafe/);
  await expect(setup(root, { install: true, scaffold: false })).rejects.toThrow(/Unsafe/);
  expect(readFileSync(outside, 'utf8')).toBe('{}');
});

it.each(['mise.toml', 'mise.lock'])(
  'rejects linked %s with scaffolding disabled before installers run',
  async (name) => {
    const { root, outside } = fixture();
    symlinkSync(outside, path.join(root, name));
    await expect(setup(root, { install: true, scaffold: false })).rejects.toThrow(/Unsafe/);
    expect(readFileSync(outside, 'utf8')).toBe('{}');
  },
);

it.each(['uv', 'poetry'])(
  'rejects a linked Python environment for %s before installation',
  async (manager) => {
    const { root, outside } = fixture();
    writeFileSync(
      path.join(root, 'pyproject.toml'),
      manager === 'poetry'
        ? '[tool.poetry]\nname = "synthetic"\nversion = "0.0.0"\n'
        : '[project]\nname = "synthetic"\nversion = "0.0.0"\n',
    );
    const external = path.join(path.dirname(outside), 'external-venv');
    mkdirSync(external);
    writeFileSync(path.join(external, 'marker'), 'unchanged');
    symlinkSync(external, path.join(root, '.venv'));
    await expect(setup(root, { install: true, scaffold: false })).rejects.toThrow(/Unsafe/);
    expect(readFileSync(path.join(external, 'marker'), 'utf8')).toBe('unchanged');
  },
);
