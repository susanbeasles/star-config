// @ts-check
import path from 'node:path';
import { version } from './assets.js';
import { NPM_NAME } from './constants.js';
import { detectStacks } from './detect.js';
import { formatGenerated } from './format.js';
import { projectFiles } from './project-files.js';
import { readManaged, writeManaged } from './managed-files.js';
import { apply, report } from './scaffold.js';
import { preserveConfiguredTools, configurationFile } from './configuration-files.js';
import { initializeTransaction } from './initialization-backups.js';
import { repositoryFiles } from './templates/repository.js';
import { lintConfigFiles, testConfigFiles } from './templates/configs.js';

/** @typedef {Record<string, unknown> & {name?: string, scripts?: Record<string, string>, dependencies?: Record<string, string>, devDependencies?: Record<string, string>, optionalDependencies?: Record<string, string>}} Manifest */

/** Initialize repository baseline and tooling. No network access, nested package install,
 * host-policy change, Git hook replacement, or execution of project scripts occurs.
 * @param {string} root
 * @param {{ requireDependency?: boolean, packageInstall?: boolean }} [options]
 * @returns {Promise<boolean>} false for an indirect dependency or the package itself.
 */
export async function initialize(root, { requireDependency = true, packageInstall = false } = {}) {
  const contents = readManaged(root, 'package.json');
  /** @type {Manifest | null} */
  let pkg = packageInstall ? {} : null;
  if (contents !== null) {
    pkg = JSON.parse(contents);
  }
  if (pkg?.name === NPM_NAME) {
    return false;
  }
  if (
    requireDependency &&
    (!pkg ||
      pkg.name === NPM_NAME ||
      !{ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }[NPM_NAME])
  ) {
    return false;
  }
  const existingFiles = projectFiles(root);
  const load = (files = existingFiles) => {
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
  addScripts(pkg);
  const files = await planInitialization(root, existingFiles, pkg, load);
  const updated = pkg ? `${JSON.stringify(pkg, null, 2)}\n` : contents;
  const preview = apply(root, files, { version: version(), dryRun: true });
  const targets = [
    ...preview.written,
    ...preview.updated,
    ...preview.removed,
    '.star/manifest.json',
  ];
  if (updated !== contents) {
    targets.push('package.json');
  }
  await initializeTransaction(root, {
    targets,
    snapshots: [
      ...new Set([...targets, ...Object.keys(files), ...existingFiles.filter(configurationFile)]),
    ],
    packageBefore: contents,
    packageAfter: updated,
    changed: Boolean(
      preview.written.length ||
      preview.updated.length ||
      preview.removed.length ||
      updated !== contents ||
      readManaged(root, '.star/manifest.json') === null,
    ),
    apply: () => {
      report(apply(root, files, { version: version() }));
      if (updated !== null && updated !== contents) {
        writeManaged(root, 'package.json', updated);
      }
    },
  });
  return true;
}

/** @param {Manifest | null} pkg */
function addScripts(pkg) {
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
}

/** @param {string} root @param {string[]} existingFiles
 * @param {Manifest | null} pkg
 * @param {(files: string[]) => import('./templates/governance.js').Ctx} load
 */
async function planInitialization(root, existingFiles, pkg, load) {
  let prospective = existingFiles;
  /** @type {Record<string, {content: string, mode?: number}>} */
  let files = {};
  for (let round = 0; round < 3; round++) {
    files = preserveConfiguredTools(root, await initializationPlan(load(prospective)), pkg);
    const next = [...new Set([...existingFiles, ...Object.keys(files)])];
    if (next.length === prospective.length && next.every((file) => prospective.includes(file))) {
      break;
    }
    prospective = next;
  }
  return files;
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
