import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadContext } from '../src/context.js';
import { apply, plan } from '../src/scaffold.js';
import { MISE_TOOLS } from '../src/tools.js';
import { makeRepo } from './helpers.js';

let repo;
afterEach(() => repo?.cleanup());

function polyglot() {
  repo = makeRepo();
  repo.put(
    'package.json',
    JSON.stringify({
      name: 'demo',
      dependencies: { react: '19', 'react-dom': '19', 'aws-cdk-lib': '2' },
    }),
  );
  repo.put('cdk.json', '{}');
  repo.put('pyproject.toml', '[project]\nname = "demo"\nversion = "0.1.0"\n');
  repo.put('uv.lock', '');
  repo.put('Cargo.toml', '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2024"\n');
  repo.put('scripts/run.sh', '#!/bin/sh\n');
  repo.put('Dockerfile', 'FROM alpine:3\n');
  repo.put('worker/wrangler.toml', 'name = "w"\n');
  repo.put('.github/workflows/ci.yml', 'on: push\n');
  return loadContext(repo.root, { owners: ['@your-org/platform'] });
}

describe('plan', () => {
  it('generates valid YAML / JSON / TOML for every structured file', async () => {
    const parse = (rel, content) => {
      if (/\.ya?ml$/.test(rel)) {
        return parseYaml(content);
      }
      if (/\.json$/.test(rel)) {
        return JSON.parse(content);
      }
      return /\.toml$/.test(rel) ? parseToml(content) : null;
    };
    for (const [rel, { content }] of Object.entries(await plan(polyglot()))) {
      expect(() => parse(rel, content), rel).not.toThrow();
    }
  });

  it('wires every detected ecosystem into dependabot with a cooldown', async () => {
    const dep = parseYaml((await plan(polyglot()))['.github/dependabot.yml'].content);
    expect(dep.updates.map((u) => u['package-ecosystem'])).toEqual([
      'npm',
      'uv',
      'cargo',
      'docker',
      'github-actions',
      'devcontainers',
    ]);
    expect(dep.updates.every((u) => u.cooldown['default-days'] === 7)).toBe(true);
  });

  it('pins exactly the native tools the stacks need', async () => {
    const mise = parseToml((await plan(polyglot()))['mise.toml'].content);
    expect(mise.settings).toEqual({ lockfile: true });
    expect(Object.keys(mise.tools).sort()).toEqual(
      [
        'actionlint',
        'bats',
        'cargo-deny',
        'gitleaks',
        'hadolint',
        'ruff',
        'semgrep',
        'shellcheck',
        'shfmt',
        'trivy',
        'uv',
        'yamllint',
      ].sort(),
    );
    expect(mise.tools.trivy).toBe(MISE_TOOLS.trivy);
  });

  it('writes agent files that point at AGENTS.md and lock down secrets', async () => {
    const files = await plan(polyglot());
    expect(files['CLAUDE.md'].content).toMatch(/^@AGENTS\.md$/m);
    expect(files['AGENTS.md'].content).toMatch(/HIPAASecurityChecks/);
    expect(files['AGENTS.md'].content).toMatch(/No PHI or PII/);
    const claude = JSON.parse(files['.claude/settings.json'].content);
    expect(claude.permissions.deny).toContain('Read(./.env)');
    expect(claude.hooks.PostToolUse[0].hooks[0].command).toContain(
      'exec /opt/agent-guard/bin/agent-guard check post-edit',
    );
    expect(parseToml(files['.codex/config.toml'].content)).toMatchObject({
      sandbox_mode: 'workspace-write',
    });
    expect(files['.github/CODEOWNERS'].content).toMatch(/^\* @your-org\/platform$/m);
  });

  it('adds Playwright only for web apps and devcontainer features per stack', async () => {
    const files = await plan(polyglot());
    expect(files['playwright.config.ts']).toBeDefined();
    const dc = JSON.parse(files['.devcontainer/devcontainer.json'].content);
    expect(Object.keys(dc.features)).toEqual(
      expect.arrayContaining([
        'ghcr.io/devcontainers/features/node:1',
        'ghcr.io/devcontainers/features/python:1',
        'ghcr.io/devcontainers/features/rust:1',
      ]),
    );
    expect(dc.customizations.vscode.extensions).toContain('SonarSource.sonarlint-vscode');
  });
});

describe('apply (manifest-aware)', () => {
  it('writes, then updates only files nobody edited', async () => {
    const ctx = polyglot();
    const files = await plan(ctx);
    const count = Object.keys(files).length;
    expect(apply(ctx.root, files, { version: '1' }).written).toHaveLength(count);
    expect(apply(ctx.root, files, { version: '1' }).unchanged).toHaveLength(count);

    writeFileSync(path.join(ctx.root, 'AGENTS.md'), '# mine\n');
    const next = {
      ...files,
      'AGENTS.md': { content: '# v2\n' },
      'SECURITY.md': { content: '# v2\n' },
    };
    const r = apply(ctx.root, next, { version: '2' });
    expect(r.kept).toEqual(['AGENTS.md']);
    expect(r.updated).toEqual(['SECURITY.md']);
    expect(readFileSync(path.join(ctx.root, 'AGENTS.md'), 'utf8')).toBe('# mine\n');

    expect(apply(ctx.root, next, { version: '2', force: true }).updated).toEqual(['AGENTS.md']);
  });

  it('never overwrites a pre-existing file it did not create', async () => {
    repo = makeRepo();
    repo.put('SECURITY.md', '# ours\n');
    const r = apply(repo.root, { 'SECURITY.md': { content: '# generated\n' } }, { version: '1' });
    expect(r.kept).toEqual(['SECURITY.md']);
  });

  it('marks hooks and the launcher executable', async () => {
    const ctx = polyglot();
    const files = await plan(ctx);
    expect(files['.star/run'].mode).toBe(0o755);
    expect(files['.husky/pre-commit'].mode).toBe(0o755);
  });
});
