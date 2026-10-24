import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

const script = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
it('explains that the default prefix needs write access or an explicit privileged install', () => {
  const result = spawnSync('/bin/sh', ['-s', '--', '--help'], { input: script, encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('/usr/local/bin');
  expect(result.stdout).toContain('sudo sh install.sh');
});

it('rejects an unwritable destination before executing any download or external command', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'star-installer-'));
  const blocked = path.join(root, 'blocked');
  chmodSync(root, 0o755);
  mkdirSync(blocked, { mode: 0o555 });
  try {
    // Fully privileged root can bypass fixture mode bits; Linux procfs remains non-writable.
    const writable = spawnSync('/bin/sh', ['-c', '[ -w "$1" ]', 'check', blocked]).status === 0;
    const destination = writable ? '/proc' : blocked;
    const result = spawnSync('/bin/sh', ['-s', '--', '--dir', destination], {
      input: script,
      encoding: 'utf8',
      cwd: root,
      env: { PATH: '/nonexistent' },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('installation directory is not writable');
    expect(result.stderr).toContain('sudo sh install.sh');
    expect(result.stderr).not.toMatch(/not found|downloading/);
  } finally {
    chmodSync(blocked, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});
