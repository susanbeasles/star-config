import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.version;
if (!/^v\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('A released Node version is required');
}
const filename = `node-${version}-headers.tar.gz`;
const base = `https://nodejs.org/dist/${version}/`;
async function download(name, limit) {
  const response = await fetch(`${base}${name}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Node header download failed: ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) {
    throw new Error('Node header download exceeds its size budget');
  }
  return bytes;
}
const checksums = (await download('SHASUMS256.txt', 128 * 1024)).toString('utf8');
const line = checksums.split('\n').find((entry) => entry.endsWith(`  ${filename}`));
const expected = line?.split(/\s+/)[0];
if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
  throw new Error('Missing official Node header checksum');
}
const archive = await download(filename, 16 * 1024 * 1024);
if (createHash('sha256').update(archive).digest('hex') !== expected) {
  throw new Error('Node header checksum mismatch');
}
const directory = path.join(root, 'build/native-headers');
mkdirSync(directory, { recursive: true });
const target = path.join(directory, filename);
writeFileSync(target, archive);
execFileSync('tar', ['-xzf', target, '-C', directory, '--strip-components=1'], {
  stdio: 'inherit',
});
execFileSync(process.execPath, [path.join(root, 'scripts/build-native.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, STAR_CONFIG_NODE_INCLUDE: path.join(directory, 'include/node') },
});
