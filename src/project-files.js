// @ts-check
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { gitRoot, listRepoFiles } from './git.js';

/** Collect project files without traversing dependency stores or symbolic links.
 * @param {string} root
 */
export function projectFiles(root) {
  if (gitRoot(root)) {
    return listRepoFiles(root);
  }
  /** @type {string[]} */
  const files = [];
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
  const visit = (/** @type {string} */ dir, depth = 0) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (
        excluded.has(entry.name) ||
        (dir === '.star' && entry.name === 'backups') ||
        entry.name === '.env' ||
        entry.name.startsWith('.env.') ||
        entry.isSymbolicLink()
      ) {
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
