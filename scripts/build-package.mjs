import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build/package');
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'configs'), { recursive: true });
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
await build({
  absWorkingDir: root,
  entryPoints: {
    'bin/star-config': 'bin/star-config.js',
    'bin/postinstall': 'bin/postinstall.js',
    'src/index': 'src/index.js',
    'src/lint-staged': 'src/lint-staged.js',
  },
  outdir: out,
  bundle: true,
  splitting: true,
  packages: 'external',
  format: 'esm',
  platform: 'node',
  target: 'node24',
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  chunkNames: 'chunks/[name]-[hash]',
});
for (const file of readdirSync(path.join(root, 'configs'))) {
  const source = readFileSync(path.join(root, 'configs', file), 'utf8');
  let content = source;
  if (file.endsWith('.mjs')) {
    content = (await transform(source, { loader: 'js', minify: true, legalComments: 'none' })).code;
  } else if (file.endsWith('.json')) {
    content = JSON.stringify(JSON.parse(source));
  }
  writeFileSync(path.join(out, 'configs', file), content);
}
const { devDependencies: _dev, scripts: _scripts, files: _files, ...manifest } = pkg;
delete manifest.private;
manifest.scripts = { postinstall: 'node bin/postinstall.js' };
manifest.files = ['bin', 'src', 'chunks', 'configs', 'LICENSE'];
writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(manifest)}\n`);
copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
chmodSync(path.join(out, 'bin/star-config.js'), 0o755);
chmodSync(path.join(out, 'bin/postinstall.js'), 0o755);
