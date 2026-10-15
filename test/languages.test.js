import { describe, expect, it } from 'vitest';
import { createLintStagedConfig, getLanguage, getLanguages, matches } from '../src/languages.js';

const SAMPLES = [
  'src/a.ts',
  'src/b.tsx',
  'x.mjs',
  'package.json',
  'styles/a.scss',
  'README.md',
  'index.html',
  'svc/app.py',
  'stubs/x.pyi',
  '.github/workflows/ci.yml',
  'k8s/deploy.yaml',
  'run.sh',
  'test/x.bats',
  'Dockerfile',
  'infra/Dockerfile.prod',
  'api.dockerfile',
  'Containerfile',
  'ios/View.swift',
  'src/lib.rs',
];

describe.each(['eslint', 'biome'])('%s profile', (jsProfile) => {
  const langs = getLanguages({ jsProfile });

  it('has unique ids', () => {
    const ids = langs.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Overlapping globs would run two writers on one file concurrently under lint-staged.
  it.each(SAMPLES)('%s belongs to exactly one language', (file) => {
    expect(langs.filter((l) => matches(l, file))).toHaveLength(1);
  });

  it('builds one lint-staged entry per language', () => {
    const cfg = createLintStagedConfig({ jsProfile });
    expect(Object.keys(cfg)).toHaveLength(langs.length);
    expect(Object.values(cfg).every((c) => c.startsWith('star-config run '))).toBe(true);
  });
});

describe('step ordering', () => {
  it('formats before linting', () => {
    expect(getLanguage('js').steps.map((s) => s.tool)).toEqual(['prettier', 'eslint']);
    expect(getLanguage('python').steps.map((s) => s.args.check?.[0])).toEqual(['format', 'check']);
    expect(getLanguage('shell').steps.map((s) => s.tool)).toEqual(['shfmt', 'shellcheck']);
  });

  it('only sends workflow files to actionlint and skips .bats for shellcheck', () => {
    const actionlint = getLanguage('yaml').steps.find((s) => s.tool === 'actionlint');
    expect(actionlint?.filter?.('.github/workflows/ci.yml')).toBe(true);
    expect(actionlint?.filter?.('k8s/deploy.yaml')).toBe(false);
    const shellcheck = getLanguage('shell').steps.find((s) => s.tool === 'shellcheck');
    expect(shellcheck?.filter?.('t/x.bats')).toBe(false);
  });

  it('biome profile hands JS to Biome and docs to Prettier', () => {
    expect(getLanguage('js', { jsProfile: 'biome' }).steps.map((s) => s.tool)).toEqual(['biome']);
    expect(matches(getLanguage('docs', { jsProfile: 'biome' }), 'package.json')).toBe(false);
  });

  it('throws on unknown language', () => {
    expect(() => getLanguage('cobol')).toThrow(/Unknown language/);
  });
});
