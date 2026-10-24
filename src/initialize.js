// @ts-check
import path from 'node:path';
import { version } from './assets.js';
import { NPM_NAME } from './constants.js';
import { detectStacks } from './detect.js';
import { formatGenerated } from './format.js';
import { projectFiles } from './project-files.js';
import { readManaged, writeManaged } from './managed-files.js';
import { converge, report } from './scaffold.js';
import { repositoryFiles } from './templates/repository.js';
import { lintConfigFiles, testConfigFiles } from './templates/configs.js';

/** Initialize repository baseline and tooling. No network access, nested package install,
 * host-policy change, Git hook replacement, or execution of project scripts occurs.
 * @param {string} root
 * @param {{ requireDependency?: boolean }} [options]
 * @returns {Promise<boolean>} false for an indirect dependency or the package itself.
 */
export async function initialize(root, { requireDependency = true } = {}) {
  const contents = readManaged(root, 'package.json');
  const pkg = contents === null ? null : JSON.parse(contents);
  if (
    requireDependency &&
    (!pkg ||
      pkg.name === NPM_NAME ||
      !{ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }[NPM_NAME])
  ) {
    return false;
  }
  const load = () => {
    const files = projectFiles(root);
    const stacks = detectStacks(root, files, true);
    const config = JSON.parse(readManaged(root, '.star/config.json') ?? '{}');
    if (stacks.node && config.jsProfile) {
      stacks.node.lintProfile = config.jsProfile;
    }
    return {
      stacks,
      files,
      repoName: path.basename(root),
      owners: config.owners ?? [],
      securityContact: config.securityContact ?? null,
      version: version(),
      skip: config.skip ?? [],
    };
  };
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
  if (pkg) {
    pkg.scripts ??= {};
    for (const [name, command] of Object.entries(scripts)) {
      if (!pkg.scripts[name] || (name === 'test' && /no test specified/.test(pkg.scripts[name]))) {
        pkg.scripts[name] = command;
      }
    }
  }
  report(await converge(root, load, { version: version() }, initializationPlan));
  const updated = pkg ? `${JSON.stringify(pkg, null, 2)}\n` : contents;
  if (updated !== null && updated !== contents) {
    writeManaged(root, 'package.json', updated);
  }
  return true;
}

/** @param {import('./templates/governance.js').Ctx} ctx */
async function initializationPlan(ctx) {
  const templates = {
    ...repositoryFiles(ctx),
    ...lintConfigFiles(ctx, { command: 'star-config' }),
    ...testConfigFiles(ctx),
  };
  const skip = new Set(ctx.skip ?? []);
  const entries = await Promise.all(
    Object.entries(templates)
      .filter(([rel]) => !skip.has(rel))
      .map(async ([rel, content]) => [rel, { content: await formatGenerated(rel, content) }]),
  );
  return Object.fromEntries(entries);
}
