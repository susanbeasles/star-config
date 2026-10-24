import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { loadContext } from '../src/context.js';
import { initialize } from '../src/initialize.js';
import { repositoryFiles } from '../src/templates/repository.js';
import { makeRepo } from './helpers.js';

const repos = [];
afterEach(() => {
  for (const repo of repos.splice(0)) {
    repo.cleanup();
  }
  vi.restoreAllMocks();
});
const fixture = () => {
  const repo = makeRepo();
  repos.push(repo);
  return repo;
};

it('uses the same policy and adapters across Node and Python repositories', () => {
  const node = fixture();
  node.put('package.json', '{"name":"synthetic-node"}');
  const python = fixture();
  python.put('pyproject.toml', '[project]\nname = "synthetic-python"\nversion = "0.1.0"\n');
  const first = repositoryFiles(loadContext(node.root));
  const second = repositoryFiles(loadContext(python.root));
  expect(Object.keys(first).sort()).toEqual(
    [
      'AGENTS.md',
      'INSTRUCTIONS.md',
      'CLAUDE.md',
      'GEMINI.md',
      'CODEX.md',
      '.github/copilot-instructions.md',
      '.github/dependabot.yml',
      '.github/codeql/codeql-config.yml',
      '.gitignore',
    ].sort(),
  );
  for (const name of Object.keys(first).filter((file) => file !== '.github/dependabot.yml')) {
    expect(first[name], name).toBe(second[name]);
  }
  for (const name of [
    'INSTRUCTIONS.md',
    'CLAUDE.md',
    'GEMINI.md',
    'CODEX.md',
    '.github/copilot-instructions.md',
  ]) {
    const target = first[name].match(/\]\(([^)]+)\)/)[1];
    expect(path.posix.normalize(path.posix.join(path.posix.dirname(name), target))).toBe(
      'AGENTS.md',
    );
  }
  const codeql = parse(first['.github/codeql/codeql-config.yml']);
  expect(codeql['disable-default-queries']).toBe(false);
  expect(codeql.queries).toContainEqual({ uses: 'security-extended' });
  expect(codeql['paths-ignore']).not.toContain('**/test/**');
  for (const files of [first, second]) {
    const updates = parse(files['.github/dependabot.yml']).updates;
    expect(
      updates.every(
        (item) => item.schedule.interval === 'weekly' && item.cooldown['default-days'] === 7,
      ),
    ).toBe(true);
  }
});

it('preserves and reports local policy and ignore-file edits during repeated initialization', async () => {
  const repo = fixture();
  repo.put('package.json', '{"dependencies":{"@susanbeasles/star-config":"0.2.0"}}');
  repo.put('AGENTS.md', '# Local policy\n');
  repo.put('.gitignore', '*.log\n!important.log\n');
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await initialize(repo.root);
  await initialize(repo.root);
  expect(readFileSync(path.join(repo.root, 'AGENTS.md'), 'utf8')).toBe('# Local policy\n');
  expect(readFileSync(path.join(repo.root, '.gitignore'), 'utf8')).toBe('*.log\n!important.log\n');
  const messages = output.mock.calls.map(([message]) => String(message)).join('');
  expect(messages).toMatch(/kept\s+AGENTS.md/);
  expect(messages).toMatch(/kept\s+\.gitignore/);
});
