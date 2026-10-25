import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Publishing is retriable: a previous successful npm upload must match this exact artifact.
const [input, version] = process.argv.slice(2);
if (!input || !/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  throw new Error('Expected tarball and exact release version');
}
const tarball = resolve(input);
if (process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN) {
  throw new Error('Token authentication is forbidden; configure npm trusted publishing');
}
const name = '@susanbeasles/star-config';
const registry = 'https://registry.npmjs.org';
const run = (...args) =>
  spawnSync('npm', args, { encoding: 'utf8', shell: false, timeout: 60_000 });
const published = run(
  'view',
  `${name}@${version}`,
  'dist.integrity',
  '--json',
  '--registry',
  registry,
);
const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
if (published.status === 0 && published.stdout.trim()) {
  if (JSON.parse(published.stdout) !== integrity) {
    throw new Error(`Refusing to replace ${name}@${version}: published integrity differs`);
  }
  process.stdout.write(`Verified existing ${name}@${version}\n`);
} else {
  if (!published.stderr.includes('E404')) {
    throw new Error(`Registry lookup failed: ${published.stderr}`);
  }
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('GitHub OIDC is unavailable; id-token: write is required');
  }
  const result = run(
    'publish',
    tarball,
    '--ignore-scripts',
    '--provenance',
    '--access',
    'public',
    '--registry',
    registry,
  );
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}
