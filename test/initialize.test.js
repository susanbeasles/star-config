import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initialize } from '../src/initialize.js';
import { loadContext } from '../src/context.js';
import { testTasks, buildTasks } from '../src/tasks.js';
import { makeRepo } from './helpers.js';

let repo;
afterEach(() => repo?.cleanup());
const manifest = { name: 'synthetic', dependencies: { '@susanbeasles/star-config': '0.2.0' } };

describe('automatic tooling initialization', () => {
  it('initializes direct consumers without modifying hooks or existing scripts', async () => {
    repo = makeRepo();
    repo.put('package.json', JSON.stringify({ ...manifest, scripts: { test: 'node --test' } }));
    repo.put('src/index.js', 'export const value = 1;');
    repo.put('src/example.test.js', '');
    repo.put('prettier.config.mjs', 'export default {};\n');
    expect(await initialize(repo.root)).toBe(true);
    const first = readFileSync(path.join(repo.root, '.star/manifest.json'), 'utf8');
    expect(await initialize(repo.root)).toBe(true);
    expect(readFileSync(path.join(repo.root, '.star/manifest.json'), 'utf8')).toBe(first);
    expect(readFileSync(path.join(repo.root, 'prettier.config.mjs'), 'utf8')).toBe(
      'export default {};\n',
    );
    expect(readFileSync(path.join(repo.root, 'lint-staged.config.mjs'), 'utf8')).toContain(
      "command: 'star-config'",
    );
    const pkg = JSON.parse(readFileSync(path.join(repo.root, 'package.json'), 'utf8'));
    expect(pkg.scripts.test).toBe('node --test');
    const ctx = loadContext(repo.root);
    expect(testTasks(ctx.stacks, ctx.files, { cwd: ctx.root })[0].id).toBe('node:test');
    expect(buildTasks(ctx.stacks, ctx.files, { cwd: ctx.root })[0].id).toBe('node:esbuild');
    expect(repo.sh('git', ['config', 'core.hooksPath']).stdout.trim()).toBe('');
    for (const file of [
      'AGENTS.md',
      'INSTRUCTIONS.md',
      'CLAUDE.md',
      'GEMINI.md',
      'CODEX.md',
      '.github/copilot-instructions.md',
      '.github/dependabot.yml',
      '.github/codeql/codeql-config.yml',
      '.yamllint.yml',
    ]) {
      expect(existsSync(path.join(repo.root, file)), file).toBe(true);
    }

    for (const file of ['.claude', '.codex', '.husky']) {
      expect(existsSync(path.join(repo.root, file))).toBe(false);
    }
  });

  it('does nothing for transitive installs or development of this package', async () => {
    repo = makeRepo();
    repo.put('package.json', '{}');
    expect(await initialize(repo.root)).toBe(false);
    repo.put('package.json', JSON.stringify({ ...manifest, name: '@susanbeasles/star-config' }));
    expect(await initialize(repo.root)).toBe(false);
    expect(existsSync(path.join(repo.root, '.star'))).toBe(false);
  });

  it('explicitly initializes non-Node projects without creating a package manifest', async () => {
    repo = makeRepo();
    repo.put('pyproject.toml', '[project]\nname = "synthetic"\nversion = "0.1.0"\n');
    expect(await initialize(repo.root, { requireDependency: false })).toBe(true);
    expect(existsSync(path.join(repo.root, 'AGENTS.md'))).toBe(true);
    expect(existsSync(path.join(repo.root, 'ruff.toml'))).toBe(true);
    expect(existsSync(path.join(repo.root, 'package.json'))).toBe(false);
  });

  it('fails before changing files when a managed destination is a symlink', async () => {
    repo = makeRepo();
    repo.put('package.json', JSON.stringify(manifest));
    mkdirSync(path.join(repo.root, 'outside'));
    symlinkSync(path.join(repo.root, 'outside'), path.join(repo.root, '.star'));
    await expect(initialize(repo.root)).rejects.toThrow(/Unsafe managed path/);
    expect(readFileSync(path.join(repo.root, 'package.json'), 'utf8')).toBe(
      JSON.stringify(manifest),
    );
    expect(existsSync(path.join(repo.root, '.editorconfig'))).toBe(false);
  });
});
