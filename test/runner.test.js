import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PACKAGE_ROOT } from '../src/assets.js';
import { getLanguage } from '../src/languages.js';
import {
  buildArgs,
  chunk,
  configArgs,
  findNpmBin,
  isStrict,
  resolveTool,
  runStep,
} from '../src/runner.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'star-runner-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('isStrict', () => {
  it.each([
    [{}, false],
    [{ CI: 'true' }, true],
    [{ CI: 'false' }, false],
    [{ STAR_CONFIG_STRICT: '1' }, true],
  ])('%j → %s', (env, expected) => {
    expect(isStrict(env)).toBe(expected);
  });
});

describe('configArgs', () => {
  const ruff = getLanguage('python').steps[0];
  const prettier = getLanguage('js').steps[0];

  it('injects the shipped config when the repo has none', () => {
    expect(configArgs(ruff, dir)).toEqual([
      '--config',
      path.join(PACKAGE_ROOT, 'configs', 'ruff.toml'),
    ]);
  });

  it('defers to a repo-local config', () => {
    writeFileSync(path.join(dir, 'ruff.toml'), 'line-length = 80\n');
    expect(configArgs(ruff, dir)).toEqual([]);
  });

  it('counts pyproject.toml only with a [tool.ruff] table', () => {
    writeFileSync(
      path.join(dir, 'pyproject.toml'),
      '[project]\nname = "x"\n# [tool.ruff] in a comment\n',
    );
    expect(configArgs(ruff, dir)).toHaveLength(2);
    writeFileSync(
      path.join(dir, 'pyproject.toml'),
      '[project]\nname = "x"\n\n[tool.ruff.lint]\nselect = ["E"]\n',
    );
    expect(configArgs(ruff, dir)).toEqual([]);
  });

  it('counts package.json only with a top-level "prettier" key, not a prettier dependency', () => {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { prettier: '3' } }),
    );
    expect(configArgs(prettier, dir)).toHaveLength(2);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ prettier: { semi: false } }));
    expect(configArgs(prettier, dir)).toEqual([]);
  });
});

it('retains the shipped flat ESLint fallback for preserved legacy configuration', () => {
  const eslint = getLanguage('js').steps.find((step) => step.tool === 'eslint');
  writeFileSync(path.join(dir, '.eslintrc.json'), '{"extends":"synthetic-legacy"}');
  writeFileSync(path.join(dir, 'package.json'), '{"eslintConfig":{"root":true}}');
  expect(configArgs(eslint, dir)).toEqual([
    '--config',
    path.join(PACKAGE_ROOT, 'configs/eslint.config.mjs'),
  ]);
  writeFileSync(path.join(dir, 'eslint.config.mjs'), 'export default [];');
  expect(configArgs(eslint, dir)).toEqual([]);
});

describe('buildArgs', () => {
  it('finds TOML sections after earlier tables without interpreting regex characters', () => {
    const step = {
      tool: 'x',
      args: { check: [] },
      install: '',
      config: {
        local: ['pyproject.toml#tool.ruff'],
        asset: 'configs/ruff.toml',
        flag: () => ['--config', 'fallback'],
      },
    };
    writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "test"\n[tool.ruff.lint]\n');
    expect(configArgs(step, dir)).toEqual([]);
    step.config.local = ['pyproject.toml#tool.*'];
    writeFileSync(path.join(dir, 'pyproject.toml'), '[tool.ruff]\n');
    expect(configArgs(step, dir)).toEqual(['--config', 'fallback']);
  });
  it('returns null when a step has no args for the mode', () => {
    expect(
      buildArgs({ tool: 'x', args: { fix: null, check: [] }, install: '' }, 'fix', dir),
    ).toBeNull();
  });
});

describe('npm resolution', () => {
  it('finds a bin by walking up node_modules (ignores package exports)', () => {
    const pkgDir = path.join(dir, 'node_modules', '@scope', 'tool');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@scope/tool', bin: { tool: 'cli.js' }, exports: {} }),
    );
    mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    expect(findNpmBin('@scope/tool', 'tool', path.join(dir, 'a', 'b'))).toBe(
      path.join(pkgDir, 'cli.js'),
    );
  });

  it('resolves eslint and prettier from star-config itself as a last resort', () => {
    expect(resolveTool(getLanguage('js').steps[1], dir)?.prefix[0]).toMatch(/eslint/);
  });

  it('prefers the project venv for python tools', () => {
    const bin = path.join(dir, '.venv', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'ruff'), '#!/bin/sh\n', { mode: 0o755 });
    expect(resolveTool(getLanguage('python').steps[0], dir)?.cmd).toBe(path.join(bin, 'ruff'));
  });
});

describe('chunk', () => {
  it('keeps every file and respects the limit', () => {
    const files = Array.from({ length: 500 }, (_, i) => `dir/file-${i}.ts`);
    const batches = chunk(files, 200);
    expect(batches.flat()).toEqual(files);
    expect(batches.every((b) => b.join(' ').length <= 200)).toBe(true);
  });
});

describe('missing tools', () => {
  const ghost = {
    tool: 'definitely-not-a-real-tool-xyz',
    args: { fix: [], check: [] },
    install: 'n/a',
  };

  it('warn and pass locally', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(runStep(ghost, { mode: 'fix', files: ['a.x'], cwd: dir, env: {} })).toBe(0);
    expect(String(err.mock.calls[0][0])).toMatch(/skipped locally/);
  });

  it('fail in CI', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(runStep(ghost, { mode: 'check', files: ['a.x'], cwd: dir, env: { CI: 'true' } })).toBe(
      1,
    );
  });
});
