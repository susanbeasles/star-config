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
  fsyncSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { IS_SEA, PACKAGE_ROOT } from './assets.js';

/** @typedef {{read(path: string): {bytes: Buffer, mode: number} | null, write(path: string, content: Buffer, mode: number, temporary: string): void, directory(path: string): boolean, remove(path: string): void}} NativeFS */
/** @type {NativeFS | undefined} */
let nativeFS;
function native() {
  if (process.platform !== 'darwin' && process.env.STAR_CONFIG_NATIVE_FS_TEST !== '1') {
    return undefined;
  }
  if (!nativeFS) {
    const name = `managed-fs-${process.platform}-${process.arch}.node`;
    const folder = IS_SEA ? path.dirname(process.execPath) : PACKAGE_ROOT;
    const relative = IS_SEA ? name : `native/${name}`;
    let target = managedPath(folder, relative);
    try {
      lstatSync(target);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT' || IS_SEA) {
        throw error;
      }
      target = managedPath(folder, `build/native/${name}`);
    }
    nativeFS = createRequire(import.meta.url)(target);
  }
  return nativeFS;
}

/** Validate every existing component, including dangling links. @param {string} root @param {string} rel @param {boolean} [directory] */
export function managedPath(root, rel, directory = false) {
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
      (leaf && !directory ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())
    ) {
      throw new Error(`Unsafe managed path: ${rel}`);
    }
  }
  return target;
}

/** Open parent directories without following any link; mutations stay on this descriptor.
 * Node has no openat API. Fail closed where its Linux fd namespace is unavailable.
 * @param {string} root @param {string} rel @param {boolean} create @param {boolean} [directory]
 */
function openParent(root, rel, create, directory = false) {
  managedPath(root, rel, directory);
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

/** Validate an existing managed directory without following any component.
 * @param {string} root @param {string} rel
 */
export function managedDirectory(root, rel) {
  const fs = native();
  if (fs) {
    return fs.directory(managedPath(root, rel, true));
  }
  let parent;
  let fd;
  try {
    parent = openParent(root, rel, false, true);
    fd = openSync(parent.target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return false;
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
    if (parent !== undefined) {
      closeSync(parent.fd);
    }
  }
}

/** @param {string} root @param {string} rel */
export function readManagedState(root, rel) {
  const fs = native();
  if (fs) {
    return fs.read(managedPath(root, rel));
  }
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
    if (info.size > 32 * 1024 * 1024) {
      throw new Error(`Managed file exceeds the 32 MiB limit: ${rel}`);
    }
    return { bytes: readFileSync(fd), mode: info.mode & 0o777 };
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
    closeSync(parent.fd);
  }
}

/** @param {string} root @param {string} rel */
export function readManaged(root, rel) {
  return readManagedState(root, rel)?.bytes.toString('utf8') ?? null;
}

/** @param {string} root @param {string} rel @param {string | Uint8Array} content @param {number} [mode] */
export function writeManaged(root, rel, content, mode = 0o644) {
  const fs = native();
  if (fs) {
    fs.write(managedPath(root, rel), Buffer.from(content), mode, `.star-write-${randomUUID()}`);
    return;
  }
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
    fsyncSync(fd);
    renameSync(temporary, parent.target);
    fsyncSync(parent.fd);
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
    'pnpmfile.cjs',
    '.pnpmfile.cjs',
    'mise.toml',
    'mise.lock',
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
    managedPath(root, rel);
  }
  managedDirectory(root, '.venv');
}

/** Remove a retired managed file without following a link or escaping its parent.
 * The caller verifies its recorded content hash before removal in an exclusively controlled checkout.
 * @param {string} root @param {string} rel
 */
export function removeManaged(root, rel) {
  const fs = native();
  if (fs) {
    fs.remove(managedPath(root, rel));
    return;
  }
  const parent = openParent(root, rel, false);
  try {
    unlinkSync(parent.target);
  } finally {
    closeSync(parent.fd);
  }
}
