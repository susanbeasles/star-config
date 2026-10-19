import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { setup } from '../src/commands.js';
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
