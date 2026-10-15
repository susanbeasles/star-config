import { afterEach, describe, expect, it } from 'vitest';
import { describeStacks, detectStacks } from '../src/detect.js';
import { makeRepo } from './helpers.js';

let repo;
afterEach(() => repo?.cleanup());

const detect = (files, pkg) => {
  repo = makeRepo();
  if (pkg) {
    repo.put('package.json', JSON.stringify(pkg));
  }
  return detectStacks(repo.root, pkg ? ['package.json', ...files] : files);
};

describe('detectStacks', () => {
  it('finds nothing in an empty repo', () => {
    const s = detect([]);
    expect(describeStacks(s)).toEqual([]);
  });

  it('detects node flavors and package manager', () => {
    const s = detect(['pnpm-lock.yaml', 'src/App.tsx'], {
      dependencies: { react: '19', 'react-dom': '19' },
    });
    expect(s.node).toMatchObject({
      pm: 'pnpm',
      typescript: true,
      react: true,
      web: true,
      reactNative: false,
    });
    expect(s.node?.lintProfile).toBe('eslint');
  });

  it('treats react-native apps as not-web (no Playwright)', () => {
    const s = detect([], { dependencies: { react: '19', 'react-native': '0.80' } });
    expect(s.node).toMatchObject({ reactNative: true, web: false });
  });

  it('detects AWS CDK', () => {
    expect(detect(['cdk.json'], { dependencies: { 'aws-cdk-lib': '2' } }).node?.cdk).toBe(true);
  });

  it('picks the biome profile only when biome is configured and eslint is not', () => {
    expect(detect(['biome.json'], {}).node?.lintProfile).toBe('biome');
    expect(detect(['biome.json', 'eslint.config.mjs'], {}).node?.lintProfile).toBe('eslint');
  });

  it.each([
    [['pyproject.toml', 'uv.lock'], 'uv'],
    [['pyproject.toml', 'poetry.lock'], 'poetry'],
    [['requirements.txt'], 'pip'],
    [['app.py'], 'uv'],
  ])('python manager for %j → %s', (files, manager) => {
    expect(detect(files).python?.manager).toBe(manager);
  });

  it('detects the long tail', () => {
    const s = detect([
      'Cargo.toml',
      'Package.swift',
      'scripts/deploy.sh',
      'infra/Dockerfile.prod',
      'worker/wrangler.jsonc',
      'main.tf',
      '.github/workflows/ci.yml',
      '.circleci/config.yml',
    ]);
    expect(describeStacks(s)).toEqual([
      'Rust',
      'Swift (SwiftPM)',
      'Shell',
      'Docker',
      'Cloudflare Workers',
      'Terraform',
      'GitHub Actions',
      'CircleCI',
    ]);
    expect(s.docker?.files).toEqual(['infra/Dockerfile.prod']);
    expect(s.cloudflare?.files).toEqual(['worker/wrangler.jsonc']);
  });
});
