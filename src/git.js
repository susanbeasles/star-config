// @ts-check
import { spawnSync } from 'node:child_process';

/**
 * Tracked + untracked-but-not-ignored files, repo-relative POSIX paths.
 * @param {string} cwd
 * @returns {string[]}
 */
export function listRepoFiles(cwd) {
  const res = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`git ls-files failed: ${res.stderr || res.error?.message}`);
  }
  return [
    ...new Set(res.stdout.split('\0').filter((file) => file && !file.startsWith('.star/backups/'))),
  ];
}

/** @param {string} cwd */
export function gitRoot(cwd) {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}
