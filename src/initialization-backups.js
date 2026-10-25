// @ts-check
import { createHash, randomUUID } from 'node:crypto';
import { version } from './assets.js';
import { configurationFile } from './configuration-files.js';
import {
  managedPath,
  readManaged,
  readManagedState,
  removeManaged,
  writeManaged,
} from './managed-files.js';

const DIRECTORY = '.star/backups';
const INDEX = `${DIRECTORY}/index.json`;
const MANIFEST = '.star/manifest.json';
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = (/** @type {Uint8Array} */ bytes) =>
  createHash('sha256').update(bytes).digest('hex');

/** @typedef {{path: string, before: string | null, mode: number, after: string | null, changed: boolean}} Snapshot */
/** @typedef {{schema: number, id: string, createdAt: string, version: string, kind: string, status: string, files: Snapshot[], packageBefore: string | null, packageAfter: string | null}} Backup */

/** @param {string} root */
function index(root) {
  const text = readManaged(root, INDEX);
  const ids = text === null ? [] : JSON.parse(text);
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !ID.test(id))) {
    throw new Error('Invalid initialization backup index');
  }
  return /** @type {string[]} */ (ids);
}

/** @param {string} root @param {Backup} backup */
function save(root, backup) {
  writeManaged(
    root,
    `${DIRECTORY}/${backup.id}.json`,
    `${JSON.stringify(backup, null, 2)}\n`,
    0o600,
  );
}

/** @param {string} root @param {string[]} paths @param {string[]} changed */
function snapshot(root, paths, changed) {
  let bytes = 0;
  return [...new Set(paths)].map((path) => {
    const state = readManagedState(root, path);
    bytes += state?.bytes.length ?? 0;
    if (bytes > 16 * 1024 * 1024) {
      throw new Error(
        'Configuration backup exceeds the 16 MiB budget; no configuration files were changed',
      );
    }
    return {
      path,
      before: state?.bytes.toString('base64') ?? null,
      mode: state?.mode ?? 0o644,
      after: null,
      changed: changed.includes(path),
    };
  });
}

/** @param {string} root @param {Backup} backup */
function register(root, backup) {
  const ids = index(root);
  // The private snapshots and index must not be accidentally committed to Git.
  for (const filename of ['.gitignore', '.npmignore']) {
    const ignored = readManaged(root, `${DIRECTORY}/${filename}`);
    if (ignored !== null && ignored !== '*\n') {
      throw new Error('The reserved backup directory has an unexpected ignore configuration');
    }
    writeManaged(root, `${DIRECTORY}/${filename}`, '*\n', 0o600);
  }
  save(root, backup);
  writeManaged(root, INDEX, `${JSON.stringify([...ids, backup.id])}\n`, 0o600);
}

/** @param {string} root @param {Snapshot} file */
function restoreBytes(root, file) {
  if (file.before === null) {
    if (readManagedState(root, file.path) !== null) {
      removeManaged(root, file.path);
    }
  } else {
    writeManaged(root, file.path, Buffer.from(file.before, 'base64'), file.mode);
  }
}

/** Run one backed-up initialization transaction. Backups are local data, never executable inputs.
 * @param {string} root
 * @param {{targets: string[], snapshots: string[], packageBefore: string|null, packageAfter: string|null, changed: boolean, apply: () => void}} operation
 */
export async function initializeTransaction(root, operation) {
  if (!operation.changed) {
    operation.apply();
    return;
  }
  for (const file of [
    ...operation.snapshots,
    INDEX,
    `${DIRECTORY}/.gitignore`,
    `${DIRECTORY}/.npmignore`,
  ]) {
    managedPath(root, file);
  }
  /** @type {Backup} */
  const backup = {
    schema: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    version: version(),
    kind: 'initialize',
    status: 'pending',
    files: snapshot(root, operation.snapshots, operation.targets),
    packageBefore: operation.packageBefore,
    packageAfter: operation.packageAfter,
  };
  register(root, backup);
  try {
    operation.apply();
    for (const file of backup.files) {
      const current = readManagedState(root, file.path);
      file.after = current === null ? null : digest(current.bytes);
    }
    backup.status = 'complete';
    save(root, backup);
    process.stderr.write(
      `star-config backup: ${DIRECTORY}/${backup.id}.json (restore: star-config restore ${backup.id})\n`,
    );
  } catch (error) {
    for (const file of [...backup.files].reverse().filter((entry) => entry.changed)) {
      restoreBytes(root, file);
    }
    backup.status = 'rolled-back';
    save(root, backup);
    throw error;
  }
}

/** @param {string} path */
function restorable(path) {
  return (
    path === MANIFEST ||
    configurationFile(path) ||
    ['AGENTS.md', 'INSTRUCTIONS.md', 'CLAUDE.md', 'GEMINI.md', 'CODEX.md'].includes(path) ||
    [
      '.github/copilot-instructions.md',
      '.github/codeql/codeql-config.yml',
      '.github/dependabot.yml',
      '.yamllint.yml',
      '.shellcheckrc',
      '.hadolint.yaml',
      '.tflint.hcl',
      'deny.toml',
      'playwright.config.ts',
      'sonar-project.properties',
      'lint-staged.config.mjs',
    ].includes(path)
  );
}

/** @param {unknown} value @returns {Backup} */
function validate(value) {
  const backup = /** @type {Backup} */ (value);
  if (
    backup?.schema !== 1 ||
    !ID.test(backup.id) ||
    !Array.isArray(backup.files) ||
    !['initialize', 'restore'].includes(backup.kind) ||
    !['complete', 'restored', 'pending', 'rolled-back'].includes(backup.status)
  ) {
    throw new Error('Invalid or incomplete initialization backup');
  }
  const paths = new Set();
  for (const file of backup.files) {
    if (
      typeof file.path !== 'string' ||
      !restorable(file.path) ||
      paths.has(file.path) ||
      typeof file.changed !== 'boolean' ||
      !Number.isInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777 ||
      (file.before !== null &&
        (typeof file.before !== 'string' ||
          Buffer.from(file.before, 'base64').toString('base64') !== file.before)) ||
      (file.after !== null &&
        (typeof file.after !== 'string' || !/^[a-f0-9]{64}$/.test(file.after)))
    ) {
      throw new Error('Invalid initialization backup entry');
    }
    paths.add(file.path);
  }
  return backup;
}

/** Preserve dependency changes made by npm after postinstall; undo only the scripts we installed.
 * @param {string} current @param {Backup} backup @param {boolean} force
 */
function restorePackage(current, backup, force) {
  const pkg = JSON.parse(current);
  const before = backup.packageBefore === null ? {} : JSON.parse(backup.packageBefore);
  const after = backup.packageAfter === null ? {} : JSON.parse(backup.packageAfter);
  const scripts = { ...pkg.scripts };
  for (const key of Object.keys(after.scripts ?? {})) {
    if (before.scripts?.[key] === after.scripts[key]) {
      continue;
    }
    if (!force && scripts[key] !== after.scripts[key]) {
      throw new Error(`Restore would overwrite a later edit to package.json scripts.${key}`);
    }
    if (Object.hasOwn(before.scripts ?? {}, key)) {
      scripts[key] = before.scripts[key];
    } else {
      delete scripts[key];
    }
  }
  if (Object.keys(scripts).length || before.scripts) {
    pkg.scripts = scripts;
  } else {
    delete pkg.scripts;
  }
  return Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`);
}

/** @param {string} root @param {string | undefined} requested */
function activeBackup(root, requested) {
  const ids = index(root);
  let backup;
  for (const id of requested ? [requested] : [...ids].reverse()) {
    if (!ID.test(id) || !ids.includes(id)) {
      throw new Error('Unknown initialization backup');
    }
    const text = readManaged(root, `${DIRECTORY}/${id}.json`);
    const candidate = validate(text === null ? null : JSON.parse(text));
    if (candidate.id !== id) {
      throw new Error('Initialization backup identity mismatch');
    }
    if (candidate.status === 'complete' && (requested || candidate.kind === 'initialize')) {
      backup = candidate;
      break;
    }
  }
  if (!backup) {
    throw new Error('No active initialization backup to restore');
  }
  return backup;
}

/** Restore the latest active initialization, refusing later edits unless explicitly forced.
 * @param {string} root @param {string | undefined} requested @param {{force?: boolean}} options
 */
export function restoreInitialization(root, requested, { force = false } = {}) {
  const backup = activeBackup(root, requested);
  const changes = backup.files.filter((file) => file.changed);
  const replacements = changes.map((file) => {
    const current = readManagedState(root, file.path);
    const hash = current === null ? null : digest(current.bytes);
    if (file.path === 'package.json' && current !== null && backup.kind === 'initialize') {
      return { file, bytes: restorePackage(current.bytes.toString('utf8'), backup, force) };
    }
    if (!force && hash !== file.after) {
      throw new Error(`Restore would overwrite a later edit: ${file.path}`);
    }
    return { file, bytes: file.before === null ? null : Buffer.from(file.before, 'base64') };
  });
  /** @type {Backup} */
  const undo = {
    schema: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    version: version(),
    kind: 'restore',
    status: 'pending',
    files: snapshot(
      root,
      changes.map((file) => file.path),
      changes.map((file) => file.path),
    ),
    packageBefore: null,
    packageAfter: null,
  };
  register(root, undo);
  try {
    for (const { file, bytes } of replacements.reverse()) {
      if (bytes === null) {
        removeManaged(root, file.path);
      } else {
        writeManaged(root, file.path, bytes, file.mode);
      }
    }
    for (const file of undo.files) {
      const current = readManagedState(root, file.path);
      file.after = current === null ? null : digest(current.bytes);
    }
    undo.status = 'complete';
    save(root, undo);
    backup.status = 'restored';
    save(root, backup);
    process.stderr.write(
      `Restored initialization ${backup.id}; backup of the restored state: ${undo.id}\n`,
    );
  } catch (error) {
    for (const file of [...undo.files].reverse()) {
      restoreBytes(root, file);
    }
    undo.status = 'rolled-back';
    save(root, undo);
    throw error;
  }
  return 0;
}
