import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root;
let tarball;
let integrity;
const script = path.resolve('scripts/publish-package.mjs');
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'star-publish-'));
  tarball = path.join(root, 'package.tgz');
  writeFileSync(tarball, 'synthetic tarball');
  integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
  writeFileSync(
    path.join(root, 'npm'),
    `#!${process.execPath}
import fs from 'node:fs';
if (process.argv[2] === 'view') {
  if (process.env.FAKE_FAILURE) {
    process.stderr.write(process.env.FAKE_FAILURE);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(process.env.FAKE_INTEGRITY));
} else {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)));
}
`,
    { mode: 0o755 },
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const run = (env = {}) =>
  spawnSync(process.execPath, [script, tarball, '1.2.3'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      NODE_AUTH_TOKEN: '',
      NPM_TOKEN: '',
      ACTIONS_ID_TOKEN_REQUEST_URL: '',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
      FAKE_INTEGRITY: integrity,
      FAKE_LOG: path.join(root, 'published'),
      ...env,
    },
  });

describe('OIDC publishing boundary', () => {
  it('accepts a retry only when the published bytes match', () => {
    expect(run().status).toBe(0);
    expect(run({ FAKE_INTEGRITY: 'sha512-different' }).status).not.toBe(0);
    expect(existsSync(path.join(root, 'published'))).toBe(false);
  });

  it('fails closed on registry errors and missing OIDC', () => {
    expect(run({ FAKE_FAILURE: 'E503 unavailable' }).status).not.toBe(0);
    expect(run({ FAKE_FAILURE: 'E404 missing' }).stderr).toMatch(/OIDC is unavailable/);
    expect(existsSync(path.join(root, 'published'))).toBe(false);
  });

  it('publishes the exact tarball with lifecycle scripts disabled', () => {
    const result = run({
      FAKE_FAILURE: 'E404 missing',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path.join(root, 'published'), 'utf8'))).toEqual([
      'publish',
      tarball,
      '--ignore-scripts',
      '--provenance',
      '--access',
      'public',
      '--registry',
      'https://registry.npmjs.org',
    ]);
  });

  it('rejects token authentication without invoking npm publish', () => {
    expect(run({ NPM_TOKEN: 'synthetic' }).stderr).toMatch(/Token authentication is forbidden/);
    expect(existsSync(path.join(root, 'published'))).toBe(false);
  });
});
