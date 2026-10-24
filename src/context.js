// @ts-check
import { existsSync, readFileSync } from 'node:fs';
import { readManaged } from './managed-files.js';
import path from 'node:path';
import { version } from './assets.js';
import { detectStacks } from './detect.js';
import { gitRoot } from './git.js';
import { projectFiles } from './project-files.js';

/**
 * @typedef {object} RepoConfig   Persisted choices in .star/config.json (committed).
 * @property {string[]} [owners]
 * @property {string | null} [securityContact]
 * @property {'eslint' | 'biome'} [jsProfile]
 * @property {string[]} [skip]   Managed files this repo opts out of (e.g. its own CI workflow).
 *
 * @typedef {import('./templates/governance.js').Ctx & { root: string, config: RepoConfig, skip: string[] }} Context
 */

/** @param {string} root @param {boolean} [managed] */
export function readRepoConfig(root, managed = false) {
  if (!managed) {
    const file = path.join(root, '.star/config.json');
    return /** @type {RepoConfig} */ (
      existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    );
  }
  return /** @type {RepoConfig} */ (JSON.parse(readManaged(root, '.star/config.json') ?? '{}'));
}

/**
 * @param {string} cwd
 * @param {Partial<RepoConfig>} [overrides]
 * @param {boolean} [managed] Require descriptor-relative reads for setup.
 * @returns {Context}
 */
export function loadContext(cwd, overrides = {}, managed = false) {
  const root = existsSync(path.join(cwd, 'package.json'))
    ? path.resolve(cwd)
    : (gitRoot(cwd) ?? path.resolve(cwd));
  const files = projectFiles(root);
  const config = {
    ...readRepoConfig(root, managed),
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  };
  const stacks = detectStacks(root, files, managed);
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
