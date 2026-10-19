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
