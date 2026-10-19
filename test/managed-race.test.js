import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const fs = await original();
  return { ...fs, renameSync: vi.fn(fs.renameSync), openSync: vi.fn(fs.openSync) };
});
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  renameSync,
  openSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readManaged, writeManaged } from '../src/managed-files.js';
const actual = await vi.importActual('node:fs');
const temporary = [];
afterEach(() => {
  vi.mocked(renameSync).mockImplementation(actual.renameSync);
  vi.mocked(openSync).mockImplementation(actual.openSync);
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'star-race-'));
  temporary.push(base);
  const root = path.join(base, 'repo'),
    outside = path.join(base, 'outside');
  mkdirSync(path.join(root, '.star'), { recursive: true });
  mkdirSync(outside);
  function swap() {
    actual.renameSync(path.join(root, '.star'), path.join(root, 'detached'));
    symlinkSync(outside, path.join(root, '.star'));
  }
  return { root, outside, swap };
}
it('anchors atomic rename to the opened parent when its name becomes a symlink', () => {
  const f = fixture();
  vi.mocked(renameSync).mockImplementationOnce((from, to) => {
    f.swap();
    actual.renameSync(from, to);
  });
  writeManaged(f.root, '.star/run', 'safe', 0o755);
  expect(existsSync(path.join(f.outside, 'run'))).toBe(false);
  expect(readFileSync(path.join(f.root, 'detached/run'), 'utf8')).toBe('safe');
});
it('anchors reads to the opened parent when its name becomes a symlink', () => {
  const f = fixture();
  writeFileSync(path.join(f.root, '.star/run'), 'source');
  writeFileSync(path.join(f.outside, 'run'), 'external');
  vi.mocked(openSync).mockImplementation((target, ...args) => {
    if (String(target).endsWith('/run')) {
      f.swap();
    }
    return actual.openSync(target, ...args);
  });
  expect(readManaged(f.root, '.star/run')).toBe('source');
});
