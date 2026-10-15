import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PACKAGE_ROOT } from '../src/assets.js';

export const CLI = path.join(PACKAGE_ROOT, 'bin', 'star-config.js');

/** A throwaway git repo with helpers. */
export function makeRepo({ linkPackage = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'star-'));
  const sh = (cmd, args, env = {}, input) =>
    spawnSync(cmd, args, {
      cwd: root,
      encoding: 'utf8',
      input,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['config', 'user.email', 'ci@example.com']);
  sh('git', ['config', 'user.name', 'ci']);
  sh('git', ['config', 'commit.gpgsign', 'false']);
  const put = (rel, content) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };
  put('.gitignore', 'node_modules/\n.venv/\ntarget/\n');
  if (linkPackage) {
    // Simulates `npm i -D star-config` without a registry: the package + its deps.
    mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    symlinkSync(PACKAGE_ROOT, path.join(root, 'node_modules', 'star-config'));
    mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    symlinkSync(CLI, path.join(root, 'node_modules', '.bin', 'star-config'));
  }
  const cli = (args, env = {}, input) =>
    sh(process.execPath, [CLI, ...args], { CI: '', ...env }, input);
  return { root, sh, put, cli, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export const out = (res) => `${res.stdout}${res.stderr}`;
