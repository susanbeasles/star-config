import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { compare, nextVersion, releasePlan } from '../scripts/release-plan.mjs';
import { makeRepo } from './helpers.js';

let repo;
afterEach(() => repo?.cleanup());

describe('release version selection', () => {
  it.each([
    ['fix: correct setup', '1.2.4'],
    ['feat(cli): add support', '1.3.0'],
    ['feat!: replace API', '2.0.0'],
    ['fix(api)!: remove unsafe API', '2.0.0'],
    ['fix: improve safety\n\nBREAKING CHANGE: removed interface', '2.0.0'],
    ['fix: improve safety\n\nBREAKING-CHANGE: removed interface', '2.0.0'],
    ['docs: improve help', '1.2.4'],
    ['build(deps): update tooling', '1.2.4'],
    ['Merge pull request #12', '1.2.4'],
    ['docs: explain commits\n\nfeat: example in the body', '1.2.4'],
  ])('%s selects %s', (message, expected) => {
    expect(nextVersion('1.2.3', [message])).toBe(expected);
  });

  it('uses the highest change and numeric ordering', () => {
    expect(nextVersion('1.9.0', ['feat: add', 'fix!: remove'])).toBe('2.0.0');
    expect(compare('v1.10.0', 'v1.9.9')).toBeGreaterThan(0);
    expect(() => nextVersion('latest', [])).toThrow(/Invalid/);
  });

  it('only reads commits since an ancestral release and repairs retries', () => {
    repo = makeRepo();
    repo.put('package.json', '{"version":"0.2.0"}');
    const git = (...args) => execFileSync('git', args, { cwd: repo.root, encoding: 'utf8' });
    git('add', '.');
    git('commit', '-qm', 'feat!: old change');
    git('tag', 'v1.0.0');
    repo.put('new.js', 'export const value = 1;');
    git('add', '.');
    git('commit', '-qm', 'feat: current change');
    const first = releasePlan(repo.root);
    expect(first.version).toBe('1.1.0');
    expect(first.notes).toBe('- feat: current change');
    git('tag', first.tag);
    expect(releasePlan(repo.root).version).toBe('1.1.0');
  });
});
