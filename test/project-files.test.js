import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { projectFiles } from '../src/project-files.js';
import { detectStacks } from '../src/detect.js';

let root;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'star-gitless-'));
});
afterEach(() => {
  chmodSync(path.join(root, 'node_modules'), 0o755);
  rmSync(root, { recursive: true, force: true });
});

it('discovers hidden project configuration while refusing dependency stores and links', () => {
  const files = [
    'package.json',
    '.github/workflows/ci.yml',
    '.circleci/config.yml',
    '.devcontainer/devcontainer.json',
    '.eslintrc.json',
    '.prettierrc',
    'src/index.js',
  ];
  for (const rel of files) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), rel.endsWith('package.json') ? '{}' : '');
  }
  for (const dir of ['node_modules', '.yarn', '.cache', '.venv', '.git', 'secrets']) {
    mkdirSync(path.join(root, dir));
    writeFileSync(path.join(root, dir, 'ignored.py'), '');
  }
  // A traversal would fail for an unprivileged runner; neither it nor the link belongs in results.
  chmodSync(path.join(root, 'node_modules'), 0o000);
  symlinkSync(path.join(root, '.yarn'), path.join(root, 'linked-store'));
  writeFileSync(path.join(root, '.env.synthetic'), '');
  const discovered = projectFiles(root);
  expect(discovered.sort()).toEqual(files.sort());
  expect(detectStacks(root, discovered)).toMatchObject({
    githubActions: true,
    circleci: true,
    devcontainer: true,
    python: null,
  });
});
