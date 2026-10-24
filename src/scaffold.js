// @ts-check
/**
 * Generates repo files from detected stacks. Every generated file is recorded in
 * .star/manifest.json with its hash, which makes `star-config sync` safe:
 *   - missing            → written
 *   - unchanged since we wrote it → updated to the new template
 *   - edited by a human  → kept (reported), unless --force
 */
import { createHash } from 'node:crypto';
import { managedPath, readManaged, writeManaged } from './managed-files.js';
import { lintConfigFiles, testConfigFiles } from './templates/configs.js';
import {
  devcontainerJson,
  gitHook,
  githubWorkflow,
  launcher,
  miseToml,
  postCreateSh,
  sonarProperties,
  vscodeExtensions,
  vscodeSettings,
} from './templates/devenv.js';
import { codeowners, dependabotYml, prTemplate, securityMd } from './templates/governance.js';
import { formatGenerated } from './format.js';
import { dim, green, log, yellow } from './runner.js';

/** @typedef {import('./templates/governance.js').Ctx} Ctx */
/** @typedef {{ content: string, mode?: number }} FileSpec */

const MANIFEST = '.star/manifest.json';
const EXEC = 0o755;

const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');

/**
 * Everything star-config can generate for this repo.
 * @param {Ctx} ctx
 * @returns {Record<string, FileSpec>}
 */
export function planRaw(ctx) {
  /** @type {Record<string, FileSpec>} */
  const files = {
    '.star/run': { content: launcher(), mode: EXEC },
    '.husky/pre-commit': { content: gitHook('pre-commit'), mode: EXEC },
    '.husky/pre-push': { content: gitHook('pre-push'), mode: EXEC },
    'mise.toml': { content: miseToml(ctx) },
    'SECURITY.md': { content: securityMd(ctx) },
    '.github/CODEOWNERS': { content: codeowners(ctx) },
    '.github/pull_request_template.md': { content: prTemplate(ctx) },
    '.github/dependabot.yml': { content: dependabotYml(ctx) },
    '.github/workflows/star-config.yml': { content: githubWorkflow(ctx) },
    '.devcontainer/devcontainer.json': { content: devcontainerJson(ctx) },
    '.devcontainer/post-create.sh': { content: postCreateSh(), mode: EXEC },
    '.vscode/extensions.json': {
      content: `${JSON.stringify({ recommendations: vscodeExtensions(ctx) }, null, 2)}\n`,
    },
    '.vscode/settings.json': { content: vscodeSettings(ctx) },
    'sonar-project.properties': { content: sonarProperties(ctx) },
  };
  for (const [rel, content] of Object.entries({
    ...lintConfigFiles(ctx),
    ...testConfigFiles(ctx),
  })) {
    files[rel] = { content };
  }
  return files;
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {FileSpec} spec
 * @param {string | undefined} recordedHash
 * @param {boolean} force
 * @returns {'written' | 'updated' | 'kept' | 'unchanged'}
 */
function decide(root, rel, spec, recordedHash, force) {
  const current = readManaged(root, rel);
  if (current === null) {
    return 'written';
  }
  if (current === spec.content) {
    return 'unchanged';
  }
  return force || recordedHash === sha(current) ? 'updated' : 'kept';
}

/**
 * planRaw() run through Prettier, so generated files pass lint as written.
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, FileSpec>>}
 */
export async function plan(ctx) {
  const skip = new Set(ctx.skip ?? []);
  const raw = Object.fromEntries(Object.entries(planRaw(ctx)).filter(([rel]) => !skip.has(rel)));
  const entries = await Promise.all(
    Object.entries(raw).map(async ([rel, spec]) => [
      rel,
      { ...spec, content: await formatGenerated(rel, spec.content) },
    ]),
  );
  return Object.fromEntries(entries);
}

/**
 * Generated files can change detection (e.g. a workflow file turns on actionlint), so
 * re-detect and re-apply until nothing changes. Converges in ≤ 3 rounds.
 * @param {string} root
 * @param {() => Ctx} load
 * @param {{ force?: boolean, version: string, dryRun?: boolean }} opts
 */
export async function converge(root, load, opts) {
  /** @type {ReturnType<typeof apply>} */
  const total = { written: [], updated: [], kept: [], unchanged: [] };
  for (let round = 0; round < 3; round++) {
    const r = apply(root, await plan(load()), opts);
    total.written.push(...r.written.filter((f) => !total.written.includes(f)));
    total.updated.push(
      ...r.updated.filter((f) => !total.updated.includes(f) && !total.written.includes(f)),
    );
    total.kept = r.kept;
    total.unchanged = r.unchanged.filter(
      (f) => !total.written.includes(f) && !total.updated.includes(f),
    );
    if (opts.dryRun || (!r.written.length && !r.updated.length)) {
      break;
    }
  }
  return total;
}

/** @param {string} root */
function readManifest(root) {
  const contents = readManaged(root, MANIFEST);
  try {
    return contents === null ? { version: null, files: {} } : JSON.parse(contents);
  } catch {
    return { version: null, files: {} };
  }
}

/**
 * @param {string} root
 * @param {Record<string, FileSpec>} files
 * @param {{ force?: boolean, version: string, dryRun?: boolean }} opts
 * @returns {{ written: string[], updated: string[], kept: string[], unchanged: string[] }}
 */
export function apply(root, files, { force = false, version, dryRun = false }) {
  for (const rel of [...Object.keys(files), MANIFEST]) {
    managedPath(root, rel);
  }
  const manifest = readManifest(root);
  const result = {
    written: /** @type {string[]} */ ([]),
    updated: /** @type {string[]} */ ([]),
    kept: /** @type {string[]} */ ([]),
    unchanged: /** @type {string[]} */ ([]),
  };
  for (const [rel, spec] of Object.entries(files)) {
    const action = decide(root, rel, spec, manifest.files[rel], force);
    if (action !== 'kept') {
      manifest.files[rel] = sha(spec.content);
    }
    if ((action === 'written' || action === 'updated') && !dryRun) {
      writeManaged(root, rel, spec.content, spec.mode);
    }
    result[action].push(rel);
  }
  if (!dryRun) {
    manifest.version = version;
    writeManaged(
      root,
      MANIFEST,
      `${JSON.stringify({ version, files: sortKeys(manifest.files) }, null, 2)}\n`,
    );
  }
  return result;
}

/** @param {Record<string, string>} obj */
const sortKeys = (obj) =>
  Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

/** @param {ReturnType<typeof apply>} r */
export function report(r) {
  for (const f of r.written) {
    log(`  ${green('write ')} ${f}`);
  }
  for (const f of r.updated) {
    log(`  ${green('update')} ${f}`);
  }
  for (const f of r.kept) {
    log(`  ${yellow('kept  ')} ${f} ${dim('(edited locally — use --force to replace)')}`);
  }
  if (r.unchanged.length) {
    log(dim(`  ${r.unchanged.length} file(s) already current`));
  }
}
