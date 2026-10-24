#!/usr/bin/env node
// Builds the single-file star-config binary for the current OS/arch with Node SEA:
//   esbuild bundle (CJS) → SEA blob (+ configs as assets) → node binary copy → postject inject.
// CI runs this on a matrix of runners (one per platform) and publishes SHA256SUMS.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
if (!os || !arch) {
  throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
}
const exe = `star-config-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root });

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. Bundle. import.meta.url doesn't exist in CJS, so derive it from __filename.
await build({
  entryPoints: [path.join(root, 'bin/star-config.js')],
  outfile: path.join(dist, 'star-config.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  minify: true,
  legalComments: 'none',
  banner: { js: "const __import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__import_meta_url' },
  logLevel: 'warning',
});

// 2. SEA config with every shipped config file as an asset.
const assets = { 'package.json': path.join(root, 'package.json') };
for (const f of readdirSync(path.join(root, 'configs'))) {
  assets[`configs/${f}`] = path.join(root, 'configs', f);
}
const seaConfig = path.join(dist, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify({
    main: path.join(dist, 'star-config.cjs'),
    output: path.join(dist, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    assets,
  }),
);
run(process.execPath, ['--experimental-sea-config', seaConfig]);

// 3. Copy node, inject the blob.
const out = path.join(dist, exe);
copyFileSync(process.execPath, out);
if (os === 'linux') {
  run('strip', ['--strip-debug', out]);
}
if (os === 'darwin') {
  run('codesign', ['--remove-signature', out]);
}
run(process.execPath, [
  path.join(root, 'node_modules/postject/dist/cli.js'),
  out,
  'NODE_SEA_BLOB',
  path.join(dist, 'sea-prep.blob'),
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(os === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
]);
if (os === 'darwin') {
  run('codesign', ['--sign', '-', out]);
}

const sum = createHash('sha256').update(readFileSync(out)).digest('hex');
writeFileSync(path.join(dist, `${exe}.sha256`), `${sum}  ${exe}\n`);
process.stdout.write(`${exe}  ${sum}\n`);
