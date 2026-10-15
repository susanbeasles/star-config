// @ts-check
/**
 * wrangler-nag: cdk-nag-style policy checks for Cloudflare Workers config
 * (wrangler.toml / wrangler.json / wrangler.jsonc). No upstream equivalent exists,
 * so star-config ships a small, opinionated rule pack. Rules apply to the top level
 * and to every `env.<name>` block.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { log, red, yellow } from './runner.js';

/** @typedef {{ id: string, level: 'error' | 'warn', message: string }} Finding */

const SECRETISH = /(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential|auth)/i;

const STRING = String.raw`"(?:\\.|[^"\\])*"`;
// Keep strings; drop // and /* */ comments.
const COMMENTS = new RegExp(String.raw`(${STRING})|\/\/[^\n]*|\/\*[^]*?\*\/`, 'g');
// Keep strings; drop a comma that directly precedes } or ].
const TRAILING_COMMAS = new RegExp(String.raw`(${STRING})|,(?=\s*[}\]])`, 'g');

/**
 * Strip comments and trailing commas from JSONC without touching string contents.
 * @param {string} src
 */
export function stripJsonc(src) {
  const keep = (/** @type {string} */ _m, /** @type {string | undefined} */ str) => str ?? '';
  return src.replaceAll(COMMENTS, keep).replaceAll(TRAILING_COMMAS, keep);
}

/** @param {string} file */
function load(file) {
  const text = readFileSync(file, 'utf8');
  return file.endsWith('.toml') ? parseToml(text) : JSON.parse(stripJsonc(text));
}

/**
 * @param {Record<string, any>} cfg
 * @param {Record<string, any>} root  top-level config (env blocks inherit some keys)
 * @param {Date} now
 * @returns {Finding[]}
 */
function checkBlock(cfg, root, now) {
  /** @type {Finding[]} */
  const findings = [];
  const date = cfg.compatibility_date ?? root.compatibility_date;
  if (!date) {
    findings.push({
      id: 'WR001',
      level: 'error',
      message: 'compatibility_date is missing; runtime behavior can change under you.',
    });
  } else if (now.getTime() - new Date(date).getTime() > 365 * 24 * 3600 * 1000) {
    findings.push({
      id: 'WR008',
      level: 'warn',
      message: `compatibility_date ${date} is over a year old; review runtime changes and bump it.`,
    });
  }
  for (const [key, value] of Object.entries(cfg.vars ?? {})) {
    if (SECRETISH.test(key) && typeof value === 'string' && value.length > 0) {
      findings.push({
        id: 'WR002',
        level: 'error',
        message: `vars.${key} looks like a secret in plaintext config. Use \`wrangler secret put ${key}\` or Secrets Store.`,
      });
    }
  }
  const routed = Boolean(cfg.routes?.length || cfg.route || root.routes?.length || root.route);
  const workersDev = cfg.workers_dev ?? root.workers_dev;
  if (routed && workersDev !== false) {
    findings.push({
      id: 'WR003',
      level: 'error',
      message:
        'Routes are configured but workers_dev is not false: the *.workers.dev URL bypasses your zone WAF and Access policies.',
    });
  }
  if (routed && (cfg.preview_urls ?? root.preview_urls) !== false) {
    findings.push({
      id: 'WR005',
      level: 'warn',
      message: 'preview_urls is not false: version preview URLs are publicly reachable.',
    });
  }
  if ((cfg.observability ?? root.observability)?.enabled !== true) {
    findings.push({
      id: 'WR004',
      level: 'warn',
      message:
        'observability.enabled is not true: no audit trail of requests/errors (keep PHI out of logs).',
    });
  }
  if (cfg.node_compat ?? root.node_compat) {
    findings.push({
      id: 'WR007',
      level: 'warn',
      message: 'node_compat is deprecated; use compatibility_flags = ["nodejs_compat"].',
    });
  }
  return findings;
}

/**
 * @param {string} file  absolute path
 * @param {Date} [now]
 * @returns {Array<Finding & { scope: string }>}
 */
export function analyzeWrangler(file, now = new Date()) {
  const cfg = load(file);
  const results = checkBlock(cfg, cfg, now).map((f) => ({ ...f, scope: 'top-level' }));
  for (const [name, envCfg] of Object.entries(cfg.env ?? {})) {
    results.push(
      ...checkBlock(/** @type {Record<string, any>} */ (envCfg), cfg, now).map((f) => ({
        ...f,
        scope: `env.${name}`,
      })),
    );
  }
  return results;
}

/**
 * @param {string[]} files  repo-relative wrangler config files
 * @param {string} cwd
 * @returns {number} exit code
 */
export function wranglerNag(files, cwd) {
  let errors = 0;
  for (const rel of files) {
    let findings;
    try {
      findings = analyzeWrangler(path.join(cwd, rel));
    } catch (err) {
      log(red(`✖ ${rel}: could not parse (${err instanceof Error ? err.message : err})`));
      errors++;
      continue;
    }
    for (const f of findings) {
      const line = `${rel} [${f.scope}] ${f.id}: ${f.message}`;
      if (f.level === 'error') {
        errors++;
        log(red(`✖ ${line}`));
      } else {
        log(yellow(`⚠ ${line}`));
      }
    }
  }
  return errors ? 1 : 0;
}
