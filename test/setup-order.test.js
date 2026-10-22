import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawnSync: vi.fn() }));
vi.mock('../src/hook-boundary.js', async (original) => ({
  ...(await original()),
  validateHostPath: vi.fn(),
}));
vi.mock('../src/runner.js', async (original) => ({ ...(await original()), exec: vi.fn(() => 0) }));
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exec } from '../src/runner.js';
import { loadContext } from '../src/context.js';
import { setup } from '../src/setup.js';
afterEach(() => vi.resetAllMocks());
it('installs mise tools before trying a newly provisioned Poetry', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'star-poetry-order-'));
  let installed = false;
  try {
    writeFileSync(
      path.join(root, 'pyproject.toml'),
      '[tool.poetry]\nname = "synthetic"\nversion = "0.0.0"\n',
    );
    writeFileSync(path.join(root, 'poetry.lock'), '');
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      if (command === 'git' && args.includes('--show-toplevel')) {
        return { status: 0, stdout: root };
      }
      if (command === 'git' && args.includes('ls-files')) {
        return { status: 0, stdout: 'pyproject.toml\0poetry.lock\0' };
      }
      if (command === 'poetry' && !installed) {
        return { error: new Error('not yet provisioned') };
      }
      if (command === 'git' && args.includes('--get')) {
        return { status: 1, stdout: '' };
      }
      if (command === 'git' && args.includes('--git-path')) {
        return { status: 0, stdout: '.git/hooks' };
      }
      return { status: 0, stdout: '' };
    });
    vi.mocked(exec).mockImplementation((command, args) => {
      if (command === 'mise' && args[0] === 'install') {
        installed = true;
      }
      return 0;
    });
    await setup(loadContext(root, {}, true), { scaffold: false, install: true });
    const calls = vi.mocked(exec).mock.calls;
    const mise = calls.findIndex(([command, args]) => command === 'mise' && args[0] === 'install');
    const poetry = calls.findIndex(([command, args]) => command === 'poetry' && args[0] === 'add');
    expect(mise).toBeGreaterThanOrEqual(0);
    expect(poetry).toBeGreaterThan(mise);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
