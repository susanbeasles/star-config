import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { apply } from '../src/scaffold.js';

const temporary = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'star-managed-'));
  temporary.push(dir);
  const root = path.join(dir, 'repo');
  mkdirSync(root);
  return { root, outside: path.join(dir, 'outside') };
}
describe('managed file containment', () => {
  it.each([
    '.star/run',
    '.husky/pre-commit',
    '.husky/pre-push',
    '.devcontainer/post-create.sh',
    '.star/manifest.json',
  ])('rejects dangling managed link %s even with force', (rel) => {
    const { root, outside } = fixture();
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    symlinkSync(outside, path.join(root, rel));
    expect(() =>
      apply(
        root,
        { [rel]: { content: 'generated', mode: 0o755 } },
        { version: 'test', force: true },
      ),
    ).toThrow(/Unsafe/);
    expect(existsSync(outside)).toBe(false);
  });
  it('rejects an existing target and symlinked parents without changing content or mode', () => {
    const { root, outside } = fixture();
    writeFileSync(outside, 'sentinel', { mode: 0o600 });
    symlinkSync(outside, path.join(root, 'target'));
    expect(() =>
      apply(root, { target: { content: 'attack', mode: 0o755 } }, { version: 'test', force: true }),
    ).toThrow(/Unsafe/);
    expect(readFileSync(outside, 'utf8')).toBe('sentinel');
    expect(statSync(outside).mode & 0o777).toBe(0o600);
    symlinkSync(path.dirname(outside), path.join(root, 'linked'), 'junction');
    expect(() => apply(root, { 'linked/new': { content: 'attack' } }, { version: 'test' })).toThrow(
      /Unsafe/,
    );
    expect(existsSync(path.join(path.dirname(outside), 'new'))).toBe(false);
  });
  it('preserves edited files and updates unchanged managed files', () => {
    const { root } = fixture();
    apply(root, { target: { content: 'first' } }, { version: 'test' });
    apply(root, { target: { content: 'next' } }, { version: 'test' });
    expect(readFileSync(path.join(root, 'target'), 'utf8')).toBe('next');
    writeFileSync(path.join(root, 'target'), 'custom');
    expect(apply(root, { target: { content: 'new' } }, { version: 'test' }).kept).toEqual([
      'target',
    ]);
  });
});
