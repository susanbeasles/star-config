// @ts-check
/**
 * Access to shipped files (configs/, templates/) that works both from npm
 * (real files next to the package) and from the single-executable binary
 * (files embedded as SEA assets and materialized to a versioned cache on demand).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** @type {{ isSea(): boolean, getAsset(key: string, encoding: string): string } | null} */
let sea = null;
try {
  sea = require('node:sea');
} catch {
  sea = null;
}

export const IS_SEA = Boolean(sea?.isSea());

export const PACKAGE_ROOT = IS_SEA
  ? path.dirname(process.execPath)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {string} */
export function version() {
  if (IS_SEA && sea) {
    return JSON.parse(sea.getAsset('package.json', 'utf8')).version;
  }
  return JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
}

/**
 * Read a shipped text file, e.g. `configs/ruff.toml` or `templates/AGENTS.md`.
 * @param {string} rel
 */
export function readAsset(rel) {
  if (IS_SEA && sea) {
    return sea.getAsset(rel, 'utf8');
  }
  return readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8');
}

/**
 * A real filesystem path for a shipped file, for tools that need `--config <path>`.
 * @param {string} rel
 */
export function assetPath(rel) {
  if (!IS_SEA) {
    return path.join(PACKAGE_ROOT, rel);
  }
  const cacheRoot = process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache');
  const target = path.join(cacheRoot, 'star-config', version(), rel);
  if (!existsSync(target)) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readAsset(rel), { mode: 0o644 });
  }
  return target;
}
