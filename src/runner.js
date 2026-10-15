// @ts-check
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assetPath, IS_SEA, PACKAGE_ROOT } from './assets.js';

/** @typedef {import('./languages.js').Step} Step */
/** @typedef {import('./languages.js').Mode} Mode */
/** @typedef {{ cmd: string, prefix: string[] }} Resolved */

/** Missing tools fail in CI (or when explicitly strict); locally they warn and skip. */
export function isStrict(env = process.env) {
  return Boolean(env.CI && env.CI !== 'false') || env.STAR_CONFIG_STRICT === '1';
}

const IS_WIN = process.platform === 'win32';

/** Tools that phone home on `--version` unless told not to. */
const QUIET_ENV = {
  SEMGREP_ENABLE_VERSION_CHECK: '0',
  SEMGREP_SEND_METRICS: 'off',
  CHECKOV_SKIP_VERSION_CHECK: 'true',
};

/** @type {Map<string, boolean>} */
const probeCache = new Map();

/**
 * Is `cmd [...prefix] --version` runnable? Cached per process. Launchers (uvx/pipx) may
 * download on first use, so they get a longer budget than plain binaries.
 * @param {string} cmd
 * @param {string[]} prefix
 */
function probe(cmd, prefix) {
  const key = [cmd, ...prefix].join(' ');
  const cached = probeCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const res = spawnSync(cmd, [...prefix, '--version'], {
    stdio: 'ignore',
    timeout: prefix.length ? 90_000 : 15_000,
    shell: false,
    env: { ...process.env, ...QUIET_ENV },
  });
  const ok = !res.error && res.status === 0;
  probeCache.set(key, ok);
  return ok;
}

/**
 * Find an npm package's bin script by walking up node_modules from `from`
 * (reads package.json directly, so `exports` restrictions don't matter).
 * @param {string} pkg
 * @param {string | undefined} binName
 * @param {string} from
 * @returns {string | null}
 */
export function findNpmBin(pkg, binName, from) {
  let dir = path.resolve(from);
  for (;;) {
    const manifest = path.join(dir, 'node_modules', pkg, 'package.json');
    if (existsSync(manifest)) {
      const { bin } = JSON.parse(readFileSync(manifest, 'utf8'));
      const rel = typeof bin === 'string' ? bin : bin?.[binName ?? pkg.split('/').pop() ?? pkg];
      if (rel) {
        return path.join(path.dirname(manifest), rel);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** The node binary to run npm tools with. In the SEA binary, execPath is star-config itself. */
function nodeBinary() {
  return IS_SEA ? 'node' : process.execPath;
}

/**
 * Resolve how to execute a step's tool.
 * Order: node_modules → .venv → PATH → pinned fallbacks (uvx/pipx/xcrun).
 * @param {Step} step
 * @param {string} cwd
 * @returns {Resolved | null}
 */
export function resolveTool(step, cwd) {
  return resolveNpm(step, cwd) ?? resolveVenv(step, cwd) ?? resolvePath(step);
}

/** @param {Step} step @param {string} cwd @returns {Resolved | null} */
function resolveNpm(step, cwd) {
  if (!step.npm) {
    return null;
  }
  const local = findNpmBin(step.npm.pkg, step.npm.bin, cwd);
  const bin = local ?? (IS_SEA ? null : findNpmBin(step.npm.pkg, step.npm.bin, PACKAGE_ROOT));
  return bin ? { cmd: nodeBinary(), prefix: [bin] } : null;
}

/** @param {Step} step @param {string} cwd @returns {Resolved | null} */
function resolveVenv(step, cwd) {
  if (!step.venv) {
    return null;
  }
  const exe = IS_WIN
    ? path.join(cwd, '.venv', 'Scripts', `${step.tool}.exe`)
    : path.join(cwd, '.venv', 'bin', step.tool);
  return existsSync(exe) ? { cmd: exe, prefix: [] } : null;
}

/** @param {Step} step @returns {Resolved | null} */
function resolvePath(step) {
  if (probe(step.tool, [])) {
    return { cmd: step.tool, prefix: [] };
  }
  for (const [cmd, ...prefix] of step.fallbacks ?? []) {
    if (probe(cmd, prefix)) {
      return { cmd, prefix };
    }
  }
  return null;
}

/**
 * Repo-local config wins; otherwise pass the shipped default.
 * `file#table` means "file exists and contains a [table] section / "table" key".
 * @param {Step} step
 * @param {string} cwd
 * @returns {string[]}
 */
export function configArgs(step, cwd) {
  const { config } = step;
  if (!config) {
    return [];
  }
  for (const name of config.local) {
    const [file, table] = name.split('#');
    const full = path.join(cwd, file);
    if (!existsSync(full)) {
      continue;
    }
    if (!table) {
      return [];
    }
    if (hasSection(full, table)) {
      return [];
    }
  }
  if (!config.flag || !config.asset) {
    return [];
  }
  return config.flag(assetPath(config.asset));
}

/**
 * JSON: top-level key exists. TOML: a [table] or [table.sub] header exists.
 * @param {string} file
 * @param {string} table
 */
function hasSection(file, table) {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    try {
      return Object.hasOwn(JSON.parse(text), table);
    } catch {
      return false;
    }
  }
  return text
    .split(/\r?\n/)
    .some((line) => line.startsWith(`[${table}]`) || line.startsWith(`[${table}.`));
}

/**
 * @param {Step} step
 * @param {Mode} mode
 * @param {string} cwd
 * @returns {string[] | null}  null when the step does not run in this mode
 */
export function buildArgs(step, mode, cwd) {
  const modeArgs = step.args[mode];
  return modeArgs === null || modeArgs === undefined
    ? null
    : [...modeArgs, ...configArgs(step, cwd)];
}

const paint = (/** @type {string} */ code) => (/** @type {string} */ s) =>
  process.stderr.isTTY && !process.env.NO_COLOR ? `\u001b[${code}m${s}\u001b[0m` : s;
export const yellow = paint('33');
export const red = paint('31');
export const dim = paint('2');
export const green = paint('32');
export const bold = paint('1');

/** @param {string} msg */
export const log = (msg) => process.stderr.write(`${msg}\n`);

/**
 * Report a missing tool: fail when strict, warn otherwise.
 * @param {string} tool
 * @param {string} install
 * @param {NodeJS.ProcessEnv} env
 */
export function missingTool(tool, install, env) {
  if (isStrict(env)) {
    log(red(`✖ ${tool} is required but not installed. Install: ${install}`));
    return 1;
  }
  log(yellow(`⚠ ${tool} not found — skipped locally (CI will enforce). Install: ${install}`));
  return 0;
}

/**
 * Run an arbitrary command without a shell (argv only — file names can't inject).
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} opts
 */
export function exec(cmd, args, { cwd, env = process.env }) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', env, shell: false });
  if (res.error) {
    log(red(`✖ ${cmd} failed to start: ${res.error.message}`));
    return 1;
  }
  return res.status ?? 1;
}

/**
 * Run one step over files, batching argv to stay under OS limits.
 * @param {Step} step
 * @param {{ mode: Mode, files: string[], cwd: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {number}
 */
export function runStep(step, { mode, files, cwd, env = process.env }) {
  const argv = buildArgs(step, mode, cwd);
  const targets = step.filter ? files.filter(step.filter) : files;
  if (argv === null || targets.length === 0) {
    return 0;
  }
  const resolved = resolveTool(step, cwd);
  if (!resolved) {
    return missingTool(step.tool, step.install, env);
  }
  let code = 0;
  const batches = step.perFile ? targets.map((f) => [f]) : chunk(targets);
  for (const batch of batches) {
    const status = exec(resolved.cmd, [...resolved.prefix, ...argv, ...batch], { cwd, env });
    if (status !== 0) {
      code = status;
    }
  }
  return code;
}

/**
 * @param {string[]} files
 * @param {number} [maxChars]  Windows CreateProcess limit is ~32k chars.
 */
export function chunk(files, maxChars = 24_000) {
  /** @type {string[][]} */
  const out = [];
  /** @type {string[]} */
  let current = [];
  let size = 0;
  for (const f of files) {
    if (current.length && size + f.length + 1 > maxChars) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(f);
    size += f.length + 1;
  }
  if (current.length) {
    out.push(current);
  }
  return out;
}
