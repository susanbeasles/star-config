import { existsSync, readFileSync, writeFileSync, statSync, symlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initialize } from '../src/initialize.js';
import { restoreInitialization } from '../src/initialization-backups.js';
import { projectFiles } from '../src/project-files.js';
import { makeRepo } from './helpers.js';

let repo;
afterEach(() => repo?.cleanup());
function project() {
  repo = makeRepo();
  repo.put(
    'package.json',
    JSON.stringify({
      name: 'synthetic',
      dependencies: { '@susanbeasles/star-config': '0.2.0' },
      scripts: { test: 'node --test' },
    }),
  );
  repo.put('src/index.js', 'export const value = 1;\n');
  return repo;
}
function backup() {
  const ids = JSON.parse(readFileSync(path.join(repo.root, '.star/backups/index.json'), 'utf8'));
  return JSON.parse(
    readFileSync(path.join(repo.root, '.star/backups', `${ids.at(-1)}.json`), 'utf8'),
  );
}

describe('reversible initialization', () => {
  it('backs up existing configurations byte-for-byte and keeps them unchanged', async () => {
    project();
    const prettier = '{"semi":false,"singleQuote":false}\n';
    repo.put('.prettierrc', prettier);
    repo.put('.eslintrc.json', '{"extends":"custom-project-rules"}\n');
    repo.put(
      'pyproject.toml',
      '[project]\nname="synthetic"\nversion="0.1.0"\n[tool.ruff]\nline-length=88\n',
    );
    await initialize(repo.root);
    expect(readFileSync(path.join(repo.root, '.prettierrc'), 'utf8')).toBe(prettier);
    expect(existsSync(path.join(repo.root, 'prettier.config.mjs'))).toBe(false);
    expect(existsSync(path.join(repo.root, 'eslint.config.mjs'))).toBe(false);
    expect(existsSync(path.join(repo.root, 'ruff.toml'))).toBe(false);
    const stored = backup();
    expect(
      Buffer.from(stored.files.find((f) => f.path === '.prettierrc').before, 'base64').toString(),
    ).toBe(prettier);
    expect(stored.status).toBe('complete');
    expect(statSync(path.join(repo.root, '.star/backups', `${stored.id}.json`)).mode & 0o777).toBe(
      0o600,
    );
    expect(projectFiles(repo.root).some((file) => file.startsWith('.star/backups/'))).toBe(false);
  });

  it('preserves embedded package configurations instead of adding competing files', async () => {
    project();
    repo.put(
      'package.json',
      JSON.stringify({
        name: 'synthetic',
        dependencies: { '@susanbeasles/star-config': '0.2.0' },
        prettier: { semi: false },
        eslintConfig: { extends: 'custom' },
      }),
    );
    await initialize(repo.root);
    expect(existsSync(path.join(repo.root, 'prettier.config.mjs'))).toBe(false);
    expect(existsSync(path.join(repo.root, 'eslint.config.mjs'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(repo.root, 'package.json'))).prettier).toEqual({
      semi: false,
    });
  });

  it('restores generated files and scripts without discarding npm dependency changes', async () => {
    project();
    await initialize(repo.root);
    const stored = backup();
    const pkg = JSON.parse(readFileSync(path.join(repo.root, 'package.json')));
    pkg.dependencies['synthetic-new-dependency'] = '1.0.0';
    repo.put('package.json', JSON.stringify(pkg));
    expect(restoreInitialization(repo.root, undefined, {})).toBe(0);
    expect(existsSync(path.join(repo.root, 'AGENTS.md'))).toBe(false);
    expect(existsSync(path.join(repo.root, 'eslint.config.mjs'))).toBe(false);
    expect(existsSync(path.join(repo.root, '.star/manifest.json'))).toBe(false);
    const restored = JSON.parse(readFileSync(path.join(repo.root, 'package.json')));
    expect(restored.scripts).toEqual({ test: 'node --test' });
    expect(restored.dependencies['synthetic-new-dependency']).toBe('1.0.0');
    expect(
      readFileSync(path.join(repo.root, '.star/backups', `${stored.id}.json`), 'utf8'),
    ).toContain('"restored"');
  });

  it('refuses to overwrite later edits, and backs them up before a forced restore', async () => {
    project();
    await initialize(repo.root);
    repo.put('eslint.config.mjs', 'export default []; // edited after initialization\n');
    expect(() => restoreInitialization(repo.root, undefined, {})).toThrow(/later edit/);
    expect(existsSync(path.join(repo.root, 'AGENTS.md'))).toBe(true);
    expect(restoreInitialization(repo.root, undefined, { force: true })).toBe(0);
    expect(backup().files.find((f) => f.path === 'eslint.config.mjs').before).toBe(
      Buffer.from('export default []; // edited after initialization\n').toString('base64'),
    );
  });

  it('does not generate duplicate snapshots on an unchanged reinstall', async () => {
    project();
    await initialize(repo.root);
    const first = readFileSync(path.join(repo.root, '.star/backups/index.json'), 'utf8');
    await initialize(repo.root);
    expect(readFileSync(path.join(repo.root, '.star/backups/index.json'), 'utf8')).toBe(first);
  });

  it('rejects a symlinked backup directory before changing any project configuration', async () => {
    project();
    const original = readFileSync(path.join(repo.root, 'package.json'), 'utf8');
    mkdirSync(path.join(repo.root, '.star'));
    mkdirSync(path.join(repo.root, 'outside'));
    symlinkSync(path.join(repo.root, 'outside'), path.join(repo.root, '.star/backups'));
    await expect(initialize(repo.root)).rejects.toThrow(/Unsafe/);
    expect(readFileSync(path.join(repo.root, 'package.json'), 'utf8')).toBe(original);
    expect(existsSync(path.join(repo.root, 'AGENTS.md'))).toBe(false);
  });

  it('rejects a backup entry that attempts to restore outside the project', async () => {
    project();
    await initialize(repo.root);
    const stored = backup();
    stored.files[0].path = '../package.json';
    writeFileSync(
      path.join(repo.root, '.star/backups', `${stored.id}.json`),
      JSON.stringify(stored),
    );
    expect(() => restoreInitialization(repo.root, stored.id, {})).toThrow(/Invalid/);
    expect(existsSync(path.join(repo.root, 'AGENTS.md'))).toBe(true);
  });
});
