// @ts-check
import { randomUUID } from 'node:crypto';
import {
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  fchmodSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';

/** Validate every existing component, including dangling links. @param {string} root @param {string} rel */
export function managedPath(root, rel) {
  if (
    path.isAbsolute(rel) ||
    rel.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Invalid managed path');
  }
  const target = path.resolve(root, rel);
  const parts = target.slice(path.parse(target).root.length).split(path.sep);
  let current = path.parse(target).root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    const leaf = index === parts.length - 1;
    if (
      info.isSymbolicLink() ||
      (leaf ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())
    ) {
      throw new Error(`Unsafe managed path: ${rel}`);
    }
  }
  return target;
}

/** Open parent directories without following any link; mutations stay on this descriptor.
 * Node has no openat API. Fail closed where its Linux fd namespace is unavailable.
 * @param {string} root @param {string} rel @param {boolean} create
 */
function openParent(root, rel, create) {
  managedPath(root, rel);
  if (process.platform !== 'linux') {
    throw new Error('Managed writes require the Linux descriptor-relative filesystem boundary');
  }
  const parts = path.resolve(root, rel).split('/').filter(Boolean);
  const leaf = parts.pop();
  let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of parts) {
      const child = `/proc/self/fd/${fd}/${part}`;
      if (create) {
        try {
          mkdirSync(child);
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') {
            throw error;
          }
        }
      }
      const next = openSync(
        child,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      closeSync(fd);
      fd = next;
    }
    return { fd, target: `/proc/self/fd/${fd}/${leaf}` };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** @param {string} root @param {string} rel */
export function readManaged(root, rel) {
  let parent;
  try {
    parent = openParent(root, rel, false);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let fd;
  try {
    try {
      fd = openSync(
        parent.target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error(`Unsafe managed file: ${rel}`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
    closeSync(parent.fd);
  }
}

/** @param {string} root @param {string} rel @param {string} content @param {number} [mode] */
export function writeManaged(root, rel, content, mode = 0o644) {
  const parent = openParent(root, rel, true);
  const temporary = `/proc/self/fd/${parent.fd}/.star-write-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, content);
    fchmodSync(fd, mode);
    renameSync(temporary, parent.target);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
    rmSync(temporary, { force: true });
    closeSync(parent.fd);
  }
}

/** Validate package-manager inputs before detection and installation.
 * As with managed writes, setup requires an exclusively controlled checkout;
 * external package managers must not race another process changing this namespace.
 * @param {string} root
 */
export function validatePackageInputs(root) {
  for (const rel of [
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    'pnpm-workspace.yaml',
    'bunfig.toml',
    'requirements.txt',
    'pyproject.toml',
    'uv.lock',
    'poetry.lock',
    'uv.toml',
    'poetry.toml',
    'setup.py',
    'setup.cfg',
  ]) {
    readManaged(root, rel);
  }
}
