import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'star-package-'));
const npm = (...args) =>
  execFileSync('npm', args, {
    cwd: work,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, INIT_CWD: work, npm_config_global: 'false' },
  });
try {
  const [pack] = JSON.parse(
    npm('pack', path.join(root, 'build/package'), '--ignore-scripts', '--json'),
  );
  assert(pack.size < 128 * 1024, `Compressed package is too large: ${pack.size}`);
  assert(pack.unpackedSize < 512 * 1024, `Package is too large: ${pack.unpackedSize}`);
  for (const { path: file } of pack.files) {
    assert(
      /^(?:bin|src|chunks|configs)\//.test(file) || ['LICENSE', 'package.json'].includes(file),
      file,
    );
    assert(!/\.map$|\.md$|AGENTS|CLAUDE|templates\/agents/.test(file), file);
  }
  const manifest = {
    name: 'synthetic-consumer',
    private: true,
    type: 'module',
    scripts: { 'custom-check': 'node --version' },
  };
  writeFileSync(path.join(work, 'package.json'), JSON.stringify(manifest));
  // Install a local tarball in a synthetic project; the registry receives dependency names only.
  npm('install', `./${pack.filename}`, '--no-audit', '--no-fund');
  // npm saves newly added dependencies after their lifecycle scripts. Refuse
  // incidental transitive initialization, then qualify the explicit recovery path.
  execFileSync(
    process.execPath,
    [path.join(work, 'node_modules/@susanbeasles/star-config/bin/star-config.js'), 'init'],
    { cwd: work },
  );
  assert(existsSync(path.join(work, '.star/manifest.json')), 'init did not initialize the project');
  const pkg = JSON.parse(readFileSync(path.join(work, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['custom-check'], 'node --version');
  assert.equal(pkg.scripts.lint, 'star-config lint');
  assert.equal(pkg.scripts['test:coverage'], 'star-config test --coverage');
  mkdirSync(path.join(work, 'src'));
  writeFileSync(path.join(work, 'src/index.js'), 'export const value = 1;\n');
  writeFileSync(
    path.join(work, 'src/value.test.js'),
    "import { expect, it } from 'vitest'; import { value } from './index.js'; it('works', () => expect(value).toBe(1));\n",
  );
  npm('run', 'test');
  npm('run', 'build');
  assert(
    existsSync(path.join(work, 'dist/value.js')) || existsSync(path.join(work, 'dist/index.js')),
    'build did not produce output',
  );
  const config = path.join(work, 'prettier.config.mjs');
  writeFileSync(config, 'export default { semi: false };\n');
  npm('rebuild', '@susanbeasles/star-config', '--offline');
  assert.equal(readFileSync(config, 'utf8'), 'export default { semi: false };\n');
  const bin = path.join(work, 'node_modules/@susanbeasles/star-config/bin/star-config.js');
  const run = (...args) =>
    execFileSync(process.execPath, [bin, ...args], { cwd: work, encoding: 'utf8' });
  assert.equal(
    run('--version').trim(),
    JSON.parse(readFileSync(path.join(root, 'package.json'))).version,
  );
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "await import('@susanbeasles/star-config'); await import('@susanbeasles/star-config/eslint'); await import('@susanbeasles/star-config/vitest')",
    ],
    { cwd: work },
  );
  for (const file of [
    'AGENTS.md',
    'CLAUDE.md',
    '.claude',
    '.codex',
    '.github/copilot-instructions.md',
  ]) {
    assert(!existsSync(path.join(work, file)), file);
  }
  process.stdout.write(
    `Packed install and explicit initialization verified: ${pack.files.length} files, ${pack.size} bytes compressed, ${pack.unpackedSize} bytes unpacked\n`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
