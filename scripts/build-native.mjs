import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const include = process.env.STAR_CONFIG_NODE_INCLUDE;
if (!include || !existsSync(path.join(include, 'node_api.h'))) {
  throw new Error('STAR_CONFIG_NODE_INCLUDE must point to verified Node API headers');
}
if (!['linux', 'darwin'].includes(process.platform)) {
  throw new Error('Native filesystem builds currently support Linux and macOS');
}
mkdirSync(path.join(root, 'build/native'), { recursive: true });
const output = path.join(root, `build/native/managed-fs-${process.platform}-${process.arch}.node`);
execFileSync(
  'cc',
  [
    '-std=c11',
    '-Os',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-fvisibility=hidden',
    '-DNAPI_VERSION=8',
    ...(process.platform === 'darwin'
      ? ['-bundle', '-undefined', 'dynamic_lookup']
      : ['-shared', '-fPIC']),
    '-I',
    include,
    path.join(root, 'native/managed-fs.c'),
    '-o',
    output,
  ],
  { stdio: 'inherit' },
);
execFileSync('strip', [process.platform === 'darwin' ? '-x' : '--strip-unneeded', output]);
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--force', '--sign', '-', output]);
}
process.stdout.write(`Built ${path.basename(output)}\n`);
