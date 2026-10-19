// Included in the standard Vitest and CI test suites.
// Payloads only create a marker in an isolated temporary fixture.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, afterEach } from 'vitest';
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
import { claudeSettings } from '../src/templates/agents.js';
import { gitHook } from '../src/templates/devenv.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'star-hook-boundary-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const checkout = path.join(root, 'checkout');
  mkdirSync(home);
  mkdirSync(path.join(checkout, '.star'), { recursive: true });
  const env = { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_PROJECT_DIR: checkout };
  const run = (cmd, args, input) =>
    spawnSync(cmd, args, { cwd: checkout, env, input, encoding: 'utf8', timeout: 10000 });
  assert.equal(run('git', ['init', '-q']).status, 0);
  const marker = path.join(root, 'host-marker');
  writeFileSync(path.join(checkout, '.star/run'), `#!/bin/sh\nprintf executed > '${marker}'\n`, {
    mode: 0o755,
  });
  return { marker, run };
}

for (const hook of ['pre-commit', 'pre-push']) {
  test(`generated ${hook} cannot execute a replaced checkout launcher on the host`, () => {
    const { marker, run } = fixture();
    const result = run('/bin/sh', ['-c', gitHook(hook)]);
    assert.notEqual(result.status, 0, 'missing host runner must fail closed');
    assert.equal(existsSync(marker), false, 'mutable checkout launcher executed automatically');
  });
}

const settings = [
  ['generated', JSON.parse(claudeSettings({ stacks: {} }))],
  ['installed', JSON.parse(readFileSync(new URL('../.claude/settings.json', import.meta.url)))],
];
for (const [label, config] of settings) {
  test(`${label} post-edit hook cannot execute a replaced checkout launcher on the host`, () => {
    const { marker, run } = fixture();
    for (const entry of config.hooks?.PostToolUse ?? []) {
      for (const hook of entry.hooks ?? []) {
        if (hook.type === 'command') {
          assert.notEqual(run('/bin/sh', ['-c', hook.command], '{}').status, 0);
        }
      }
    }
    assert.equal(existsSync(marker), false, 'mutable checkout launcher executed automatically');
  });
}

for (const hook of ['pre-commit', 'pre-push']) {
  test(`installed ${hook} dispatches only the fixed runner`, () => {
    const content = readFileSync(new URL(`../.husky/${hook}`, import.meta.url), 'utf8');
    assert.equal(content, gitHook(hook));
    assert.match(content, /exec \/opt\/agent-guard\/bin\/agent-guard check/);
    assert.doesNotMatch(content, /\.star\/run|node_modules|exec node|\$PATH|\$CLAUDE_PROJECT_DIR/);
  });
}
test('package prepare cannot restore Husky', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.doesNotMatch(pkg.scripts.prepare ?? '', /husky/);
});
