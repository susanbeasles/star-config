// Explicit qualification in an ephemeral Linux runner. Never replace an existing host guard.
// The recorder accepts only this fixture checkout; it is not an isolation implementation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD, HOOKS, guardCommand } from '../src/hook-boundary.js';
import { installHooks } from '../src/setup.js';
import { gitHook } from '../src/templates/devenv.js';

const enabled = process.env.STAR_CONFIG_TEST_HOST_FIXTURE === '1';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

describe.skipIf(!enabled)('real Git dispatch through the fixed host hook directory', () => {
  let root;
  let checkout;
  let remote;
  let ownsHost = false;

  const run = (command, args, input, cwd = checkout) =>
    spawnSync(command, args, {
      cwd,
      input,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    });
  const git = (args, cwd = checkout) => {
    const result = run('git', args, undefined, cwd);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const record = () => readFileSync(path.join(root, 'arguments'), 'utf8').trim().split('\n');
  const policy = (code) => writeFileSync(path.join(root, 'exit-code'), String(code));

  beforeAll(() => {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) {
      throw new Error('Hook qualification requires an ephemeral Linux runner with root access.');
    }
    // mkdir is exclusive: an installed runner, directory, or symlink causes refusal.
    mkdirSync('/opt/agent-guard', { mode: 0o755 });
    ownsHost = true;
    root = mkdtempSync(path.join(process.cwd(), '.hook-dispatch-'));
    checkout = path.join(root, 'checkout');
    remote = path.join(root, 'remote.git');
    mkdirSync(checkout);
    mkdirSync(path.dirname(GUARD), { mode: 0o755 });
    mkdirSync(HOOKS, { mode: 0o755 });
    writeFileSync(
      GUARD,
      `#!/bin/sh
set -eu
[ "$PWD" = ${quote(checkout)} ] || exit 127
printf '%s\\n' "$@" > ${quote(path.join(root, 'arguments'))}
/bin/cat > ${quote(path.join(root, 'stdin'))}
exit "$(/bin/cat ${quote(path.join(root, 'exit-code'))})"
`,
      { mode: 0o755, flag: 'wx' },
    );
    for (const phase of ['pre-commit', 'pre-push']) {
      writeFileSync(path.join(HOOKS, phase), gitHook(phase), { mode: 0o755, flag: 'wx' });
    }
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'Synthetic fixture']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    assert.equal(installHooks({ root: checkout }), 0);
    policy(0);
    git(['commit', '--allow-empty', '-m', 'Fixture baseline']);
    git(['init', '-q', '--bare', remote]);
    git(['remote', 'add', 'origin', remote]);
    git(['push', 'origin', 'main']);
  });

  beforeEach(() => policy(0));
  afterAll(() => {
    vi.unstubAllEnvs();
    if (ownsHost) {
      rmSync('/opt/agent-guard', { recursive: true, force: true });
    }
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('registers the fixed directory and dispatches a real commit through its hook', () => {
    expect(git(['config', '--local', 'core.hooksPath'])).toBe(HOOKS);
    writeFileSync(path.join(checkout, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 99\n', {
      mode: 0o755,
    });
    git(['commit', '--allow-empty', '-m', 'Allowed fixture commit']);
    expect(record()).toEqual(['check', 'pre-commit']);
  });

  it('blocks a real commit when the host check fails', () => {
    const before = git(['rev-parse', 'HEAD']);
    policy(42);
    expect(
      run('git', ['commit', '--allow-empty', '-m', 'Rejected fixture commit']).status,
    ).not.toBe(0);
    expect(git(['rev-parse', 'HEAD'])).toBe(before);
    expect(record()).toEqual(['check', 'pre-commit']);
  });

  it('forwards the remote arguments and ref-update stdin during a real push', () => {
    const before = git(['rev-parse', 'refs/heads/main'], remote);
    git(['commit', '--allow-empty', '-m', 'Push argument fixture']);
    const head = git(['rev-parse', 'HEAD']);
    git(['push', 'origin', 'main']);
    expect(record()).toEqual(['check', 'pre-push', 'origin', remote]);
    expect(readFileSync(path.join(root, 'stdin'), 'utf8').trim().split(/\s+/)).toEqual([
      'refs/heads/main',
      head,
      'refs/heads/main',
      before,
    ]);
    expect(git(['rev-parse', 'refs/heads/main'], remote)).toBe(head);
  });

  it('blocks a real push when the host check fails', () => {
    const before = git(['rev-parse', 'refs/heads/main'], remote);
    git(['commit', '--allow-empty', '-m', 'Unpublished fixture commit']);
    policy(42);
    expect(run('git', ['push', 'origin', 'main']).status).not.toBe(0);
    expect(git(['rev-parse', 'refs/heads/main'], remote)).toBe(before);
    expect(record()[1]).toBe('pre-push');
  });

  it('blocks a real commit when the fixed runner disappears', () => {
    const before = git(['rev-parse', 'HEAD']);
    renameSync(GUARD, `${GUARD}.fixture`);
    try {
      const result = run('git', ['commit', '--allow-empty', '-m', 'Missing runner']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('agent-guard is unavailable');
      expect(git(['rev-parse', 'HEAD'])).toBe(before);
    } finally {
      renameSync(`${GUARD}.fixture`, GUARD);
    }
  });

  it('preserves post-edit input and exit status and rejects other working directories', () => {
    policy(2);
    const input = '{"tool_input":{"file_path":"synthetic.js"}}';
    expect(run('/bin/sh', ['-c', guardCommand('post-edit')], input).status).toBe(2);
    expect(record()).toEqual(['check', 'post-edit']);
    expect(readFileSync(path.join(root, 'stdin'), 'utf8')).toBe(input);
    expect(run(GUARD, ['check', 'pre-commit'], '', root).status).toBe(127);
  });
});
