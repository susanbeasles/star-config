// @ts-check
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { gitRoot, listRepoFiles } from './git.js';

const excluded = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  'vendor',
  'coverage',
  '.git',
  '.hg',
  '.svn',
  '.venv',
  '.yarn',
  '.pnpm-store',
  '.npm',
  '.cache',
  '.next',
  '.nuxt',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.terraform',
  '.build',
  '.swiftpm',
  'secrets',
]);

/** Exclude dependency stores, private inputs, and generated outputs in either discovery mode.
 * @param {string} file
 */
export function isProjectFile(file) {
  const parts = file.split('/');
  return (
    !parts.some((part) => excluded.has(part) || part.startsWith('.env')) &&
    !file.startsWith('.star/backups/')
  );
}

/** Collect project files without traversing dependency stores or symbolic links.
 * @param {string} root
 */
export function projectFiles(root) {
  if (gitRoot(root)) {
    return listRepoFiles(root).filter(isProjectFile);
  }
  /** @type {string[]} */
  const files = [];
  const visit = (/** @type {string} */ dir, depth = 0) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (!isProjectFile(path.posix.join(dir, entry.name)) || entry.isSymbolicLink()) {
        continue;
      }
      const rel = path.posix.join(dir, entry.name);
      if (entry.isFile()) {
        files.push(rel);
      } else if (entry.isDirectory() && depth < 8) {
        visit(rel, depth + 1);
      }
      if (files.length > 10_000) {
        throw new Error('Project discovery exceeded 10000 files');
      }
    }
  };
  visit('');
  return files;
}
