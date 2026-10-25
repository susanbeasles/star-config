import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  linkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../src/assets.js';
import { makeRepo } from './helpers.js';

const binary = path.join(
  PACKAGE_ROOT,
  `build/native/managed-fs-${process.platform}-${process.arch}.node`,
);
const available = existsSync(binary);
if (process.env.STAR_CONFIG_REQUIRE_NATIVE_TESTS === '1' && !available) {
  throw new Error('Native filesystem qualification requires a compiled filesystem module');
}
const native = available ? createRequire(import.meta.url)(binary) : null;
let repo;
afterEach(() => repo?.cleanup());
describe.runIf(available)('native descriptor-relative filesystem boundary', () => {
  it('writes atomically, preserves bytes and mode, and removes only the selected file', () => {
    repo = makeRepo();
    const file = path.join(repo.root, 'nested/config.json');
    const bytes = Buffer.from([0, 255, 10, 13]);
    native.write(file, bytes, 0o600, '.star-write-synthetic');
    expect(native.read(file).bytes).toEqual(bytes);
    expect(native.read(file).mode).toBe(0o600);
    expect(native.directory(path.dirname(file))).toBe(true);
    native.remove(file);
    expect(native.read(file)).toBeNull();
  });
  it('refuses symbolic and hard links without changing the referenced content', () => {
    repo = makeRepo();
    const original = path.join(repo.root, 'original');
    writeFileSync(original, 'original');
    const linked = path.join(repo.root, 'linked');
    symlinkSync(original, linked);
    expect(() => native.read(linked)).toThrow();
    expect(() =>
      native.write(linked, Buffer.from('changed'), 0o644, '.star-write-synthetic'),
    ).toThrow();
    const hard = path.join(repo.root, 'hard');
    linkSync(original, hard);
    expect(() => native.read(hard)).toThrow();
    expect(() => native.remove(hard)).toThrow();
    expect(readFileSync(original, 'utf8')).toBe('original');
  });
  it('refuses linked parents and retains restrictive modes even under a permissive umask', () => {
    repo = makeRepo();
    const outside = path.join(repo.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(repo.root, 'redirect'));
    expect(() =>
      native.write(
        path.join(repo.root, 'redirect/config'),
        Buffer.from('refused'),
        0o600,
        '.star-write-synthetic',
      ),
    ).toThrow();
    expect(existsSync(path.join(outside, 'config'))).toBe(false);
    // eslint-disable-next-line sonarjs/file-permissions -- Deliberately permissive test; finally restores it.
    const previous = process.umask(0);
    try {
      const file = path.join(repo.root, 'private');
      native.write(file, Buffer.from('private'), 0o600, '.star-write-synthetic');
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });
});
