import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { githubWorkflow } from '../src/templates/devenv.js';
it.each([
  null,
  { manager: 'uv', hasPyproject: true },
  { manager: 'pip', hasPyproject: false },
  { manager: 'poetry', hasPyproject: true },
])('generates hosted checks without requiring host hook installation: %j', (python) => {
  const output = githubWorkflow({ stacks: { node: { pm: 'npm' }, python }, version: '0.2.0' });
  const job = parse(output).jobs.check;
  expect(job['runs-on']).toBe('ubuntu-latest');
  const scripts = job.steps.map((step) => step.run ?? '').join('\n');
  expect(scripts).not.toMatch(/run setup|run hooks/);
  expect(scripts).toContain('npm ci');
  expect(scripts).toContain('.star/run check --coverage');
  expect(scripts.includes('pytest==')).toBe(Boolean(python));
});

it('allows script-only Python without an optional requirements file', () => {
  const scripts = parse(
    githubWorkflow({
      stacks: { python: { manager: 'pip', hasPyproject: false } },
      version: '0.2.0',
    }),
  )
    .jobs.check.steps.map((step) => step.run ?? '')
    .join('\n');
  expect(scripts).toContain('if [ -f requirements.txt ]; then');
  expect(scripts).toContain('uv pip install --python .venv/bin/python ruff==');
});

it.each([false, true])('selects a valid uv sync mode with lockfile=%s', (locked) => {
  const root = mkdtempSync(path.join(tmpdir(), 'star-ci-lock-'));
  try {
    mkdirSync(path.join(root, 'bin'));
    writeFileSync(path.join(root, 'bin/uv'), '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o755 });
    if (locked) {
      writeFileSync(path.join(root, 'uv.lock'), 'fixture');
    }
    const job = parse(
      githubWorkflow({
        stacks: { python: { manager: 'uv', hasPyproject: true } },
        version: '0.2.0',
      }),
    ).jobs.check;
    const step = job.steps.find((item) => item.name === 'Install Python test prerequisites');
    const output = execFileSync('bash', ['-e', '-c', step.run], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}/bin:${process.env.PATH}`,
        GITHUB_PATH: path.join(root, 'github-path'),
      },
      encoding: 'utf8',
    });
    expect(output.split('\n')[0]).toBe(locked ? 'sync --frozen --all-groups' : 'sync --all-groups');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['npm', 'pnpm', 'yarn', 'bun'])(
  'bootstraps the exact CLI for %s projects without assuming a declared dependency',
  (pm) => {
    const job = parse(githubWorkflow({ stacks: { node: { pm } }, version: '0.2.0' })).jobs.check;
    const bootstrap = job.steps.find((step) => step.name === 'Install pinned star-config CLI');
    expect(bootstrap['working-directory']).toBe('${{ runner.temp }}');
    expect(bootstrap.run).toContain('"star-config@0.2.0"');
    expect(bootstrap.run).toContain('--ignore-scripts');
    expect(bootstrap.run).toContain('--registry https://registry.npmjs.org');
    expect(bootstrap.run).toContain('GITHUB_PATH');
    expect(bootstrap.env.NPM_CONFIG_USERCONFIG).toBe('/dev/null');
  },
);
it('rejects non-exact CLI versions instead of generating a mutable or executable bootstrap', () => {
  for (const version of ['latest', '^0.2.0', '0.2.0;echo unsafe']) {
    expect(() => githubWorkflow({ stacks: { node: { pm: 'npm' } }, version })).toThrow(/exact/);
  }
});
