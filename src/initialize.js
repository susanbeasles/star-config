// @ts-check
import path from 'node:path';
import { version } from './assets.js';
import { NPM_NAME } from './constants.js';
import { detectStacks } from './detect.js';
import { formatGenerated } from './format.js';
import { projectFiles } from './project-files.js';
import { readManaged, writeManaged } from './managed-files.js';
import { apply } from './scaffold.js';
import { lintConfigFiles, testConfigFiles } from './templates/configs.js';

/** Initialize only project tooling. No network, child package install, policy changes,
 * Git hook replacement, or execution of project scripts occurs during installation.
 * @param {string} root
 * @returns {Promise<boolean>} false for an indirect dependency or the package itself.
 */
export async function initialize(root) {
  const contents = readManaged(root, 'package.json');
  if (contents === null) {
    return false;
  }
  const pkg = JSON.parse(contents);
  if (
    pkg.name === NPM_NAME ||
    !{ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }[NPM_NAME]
  ) {
    return false;
  }
  const files = projectFiles(root);
  const stacks = detectStacks(root, files, true);
  const config = JSON.parse(readManaged(root, '.star/config.json') ?? '{}');
  if (stacks.node && config.jsProfile) {
    stacks.node.lintProfile = config.jsProfile;
  }
  const ctx = {
    stacks,
    files,
    repoName: path.basename(root),
    owners: [],
    securityContact: null,
    version: version(),
    skip: config.skip ?? [],
  };
  const templates = {
    ...lintConfigFiles(ctx, { command: 'star-config' }),
    ...testConfigFiles(ctx),
  };
  const entries = await Promise.all(
    Object.entries(templates)
      .filter(([rel]) => !ctx.skip.includes(rel))
      .map(async ([rel, content]) => [rel, { content: await formatGenerated(rel, content) }]),
  );
  // Validate the complete write set before making the first change.
  const scripts = {
    lint: 'star-config lint',
    'lint:fix': 'star-config lint --fix',
    format: 'star-config format',
    test: 'star-config test',
    'test:coverage': 'star-config test --coverage',
    build: 'star-config build',
    audit: 'star-config audit',
    check: 'star-config check',
  };
  pkg.scripts ??= {};
  for (const [name, command] of Object.entries(scripts)) {
    if (!pkg.scripts[name] || (name === 'test' && /no test specified/.test(pkg.scripts[name]))) {
      pkg.scripts[name] = command;
    }
  }
  apply(root, Object.fromEntries(entries), { version: version() });
  const updated = `${JSON.stringify(pkg, null, 2)}\n`;
  if (updated !== contents) {
    writeManaged(root, 'package.json', updated);
  }
  return true;
}
