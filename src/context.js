// @ts-check
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { version } from './assets.js';
import { detectStacks } from './detect.js';
import { gitRoot, listRepoFiles } from './git.js';

/**
 * @typedef {object} RepoConfig   Persisted choices in .star/config.json (committed).
 * @property {string[]} [owners]
 * @property {string | null} [securityContact]
 * @property {'eslint' | 'biome'} [jsProfile]
 * @property {string[]} [skip]   Managed files this repo opts out of (e.g. its own CI workflow).
 *
 * @typedef {import('./templates/governance.js').Ctx & { root: string, config: RepoConfig, skip: string[] }} Context
 */

/** @param {string} root */
export function readRepoConfig(root) {
  const file = path.join(root, '.star', 'config.json');
  if (!existsSync(file)) {
    return /** @type {RepoConfig} */ ({});
  }
  return /** @type {RepoConfig} */ (JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * @param {string} cwd
 * @param {Partial<RepoConfig>} [overrides]
 * @returns {Context}
 */
export function loadContext(cwd, overrides = {}) {
  const root = gitRoot(cwd);
  if (!root) {
    throw new Error('Not inside a git repository. Run `git init` first.');
  }
  const files = listRepoFiles(root);
  const config = {
    ...readRepoConfig(root),
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  };
  const stacks = detectStacks(root, files);
  if (stacks.node && config.jsProfile) {
    stacks.node.lintProfile = config.jsProfile;
  }
  return {
    root,
    files,
    stacks,
    config,
    repoName: path.basename(root),
    owners: config.owners ?? [],
    securityContact: config.securityContact ?? null,
    version: version(),
    skip: config.skip ?? [],
  };
}
