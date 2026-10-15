// @ts-check
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assetPath, IS_SEA, version } from './assets.js';
import { loadContext } from './context.js';
import { describeStacks } from './detect.js';
import { createLintStagedConfig, getLanguage, getLanguages, matches } from './languages.js';
import {
  bold,
  dim,
  exec,
  green,
  isStrict,
  log,
  missingTool,
  red,
  resolveTool,
  runStep,
  yellow,
} from './runner.js';
import { formatGenerated } from './format.js';
import { converge, report } from './scaffold.js';
import { installHooks, setup as runSetup } from './setup.js';
import { sonar } from './sonar.js';
import { auditTasks, buildTasks, testTasks } from './tasks.js';
import { miseToolsFor } from './templates/devenv.js';
import { MISE_TOOLS } from './tools.js';

/** @typedef {import('./context.js').Context} Context */
/** @typedef {import('./tasks.js').Task} Task */
/** @typedef {import('./languages.js').Language} Language */

/** @param {Context} ctx */
const profile = (ctx) => ({ jsProfile: ctx.stacks.node?.lintProfile ?? 'eslint' });

/**
 * @param {Context} ctx
 * @returns {Array<{ lang: Language, files: string[] }>}
 */
function filesByLanguage(ctx) {
  return getLanguages(profile(ctx))
    .map((lang) => ({ lang, files: ctx.files.filter((f) => matches(lang, f)) }))
    .filter((x) => x.files.length);
}

/**
 * @param {Task} task
 * @param {Context} ctx
 */
function runTask(task, ctx) {
  log(dim(`── ${task.id}`));
  if (task.fn) {
    return task.fn({ cwd: ctx.root, env: process.env });
  }
  const resolved = resolveTool(
    {
      tool: task.tool,
      npm: task.npm,
      venv: task.venv,
      fallbacks: task.fallbacks,
      args: {},
      install: task.install,
    },
    ctx.root,
  );
  if (!resolved) {
    return missingTool(task.tool, task.install, process.env);
  }
  const code = exec(resolved.cmd, [...resolved.prefix, ...task.args], {
    cwd: ctx.root,
    env: { ...process.env, ...task.env },
  });
  return task.okCodes?.includes(code) ? 0 : code;
}

/**
 * @param {string} title
 * @param {Task[]} tasks
 * @param {Context} ctx
 */
function runTasks(title, tasks, ctx) {
  if (!tasks.length) {
    log(
      dim(`${title}: nothing to run for ${describeStacks(ctx.stacks).join(', ') || 'this repo'}`),
    );
    return 0;
  }
  const failed = tasks.filter((t) => runTask(t, ctx) !== 0).map((t) => t.id);
  return summarize(title, failed);
}

/**
 * @param {string} title
 * @param {string[]} failed
 */
function summarize(title, failed) {
  if (failed.length) {
    log(red(`✖ ${title} failed: ${[...new Set(failed)].join(', ')}`));
    return 1;
  }
  log(green(`✔ ${title} passed`));
  return 0;
}

/**
 * Linters that work on a whole project rather than a file list.
 * @param {Context} ctx
 * @returns {Task[]}
 */
function repoLintTasks(ctx) {
  /** @type {Task[]} */
  const tasks = [];
  if (ctx.stacks.rust) {
    tasks.push({
      id: 'rust:clippy',
      tool: 'cargo',
      args: ['clippy', '--all-targets', '--all-features', '--', '-D', 'warnings'],
      install: 'rustup component add clippy',
    });
  }
  if (ctx.stacks.terraform) {
    const ownConfig = existsSync(path.join(ctx.root, '.tflint.hcl'));
    tasks.push({
      id: 'terraform:tflint',
      tool: 'tflint',
      args: [
        '--recursive',
        '--format',
        'compact',
        ...(ownConfig ? [] : ['--config', assetPath('configs/tflint.hcl')]),
      ],
      install: `mise use tflint@${MISE_TOOLS.tflint}`,
    });
  }
  return tasks;
}

/**
 * `lint` (read-only by default), `lint --fix`, `format` (formatters only, writes).
 * @param {Context} ctx
 * @param {{ fix?: boolean, formatOnly?: boolean }} opts
 */
export function lint(ctx, { fix = false, formatOnly = false }) {
  const mode = fix || formatOnly ? 'fix' : 'check';
  /** @type {string[]} */
  const failed = [];
  for (const { lang, files } of filesByLanguage(ctx)) {
    log(dim(`── ${lang.label} (${files.length})`));
    for (const step of lang.steps.filter((s) => !formatOnly || s.format)) {
      if (runStep(step, { mode, files, cwd: ctx.root }) !== 0) {
        failed.push(`${lang.id}:${step.tool}`);
      }
    }
  }
  if (!formatOnly) {
    for (const task of repoLintTasks(ctx)) {
      if (runTask(task, ctx) !== 0) {
        failed.push(task.id);
      }
    }
  }
  return summarize(formatOnly ? 'format' : 'lint', failed);
}

/**
 * `run <lang> [--check] files…` — lint-staged entry point. Formatter then linter, sequentially.
 * @param {string} langId
 * @param {string[]} files
 * @param {{ cwd: string, check?: boolean }} opts
 */
export function run(langId, files, { cwd, check = false }) {
  const ctx = loadContext(cwd);
  const lang = getLanguage(langId, profile(ctx));
  const rel = files.map((f) => (path.isAbsolute(f) ? path.relative(ctx.root, f) : f));
  for (const step of lang.steps) {
    const code = runStep(step, { mode: check ? 'check' : 'fix', files: rel, cwd: ctx.root });
    if (code !== 0) {
      return code;
    }
  }
  return 0;
}

/** @param {Context} ctx @param {{ e2e?: boolean, coverage?: boolean }} opts */
export const test = (ctx, opts) =>
  runTasks('test', testTasks(ctx.stacks, ctx.files, { cwd: ctx.root, ...opts }), ctx);

/** @param {Context} ctx @param {{ docker?: boolean }} opts */
export const build = (ctx, opts) =>
  runTasks('build', buildTasks(ctx.stacks, ctx.files, { cwd: ctx.root, ...opts }), ctx);

/** @param {Context} ctx */
export const audit = (ctx) =>
  runTasks('audit', auditTasks(ctx.stacks, ctx.files, { cwd: ctx.root }), ctx);

/**
 * Everything CI runs. Stops nothing early: you see every failure in one pass.
 * @param {Context} ctx
 * @param {{ coverage?: boolean, e2e?: boolean }} opts
 */
export function check(ctx, opts) {
  const results = { lint: lint(ctx, {}), test: test(ctx, opts), audit: audit(ctx) };
  const failed = Object.entries(results)
    .filter(([, c]) => c !== 0)
    .map(([k]) => k);
  log('');
  return summarize('star-config check', failed);
}

/**
 * Secrets scan of the staged diff, then lint-staged with star-config's config
 * (or the repo's own lint-staged config, if it has one).
 * @param {Context} ctx
 */
export async function preCommit(ctx) {
  const gitleaks = runTask(
    {
      id: 'secrets:gitleaks (staged)',
      tool: 'gitleaks',
      args: ['git', '--pre-commit', '--staged', '--redact', '--verbose', '--no-banner'],
      install: `mise use gitleaks@${MISE_TOOLS.gitleaks}`,
    },
    ctx,
  );
  if (gitleaks !== 0) {
    log(red('✖ Possible secret in staged changes. Remove it (and rotate it if it was real).'));
    return 1;
  }
  const { default: lintStaged } = await import('lint-staged');
  const own = [
    '.lintstagedrc',
    '.lintstagedrc.json',
    '.lintstagedrc.yaml',
    '.lintstagedrc.yml',
    '.lintstagedrc.mjs',
    '.lintstagedrc.js',
    '.lintstagedrc.cjs',
    'lint-staged.config.js',
    'lint-staged.config.mjs',
    'lint-staged.config.cjs',
  ].some((f) => existsSync(path.join(ctx.root, f)));
  // In a binary install the repo's config may import from node_modules that doesn't exist; use ours.
  const useOwn = own && !IS_SEA;
  const ok = await lintStaged({
    cwd: ctx.root,
    ...(useOwn
      ? {}
      : {
          config: createLintStagedConfig({
            command: IS_SEA ? JSON.stringify(process.execPath) : '.star/run',
            ...profile(ctx),
          }),
        }),
  });
  return ok ? 0 : 1;
}

/**
 * Fast feedback before code leaves the machine: lint (read-only) + unit tests.
 * @param {Context} ctx
 */
export function prePush(ctx) {
  const l = lint(ctx, {});
  const t = test(ctx, {});
  return l || t ? 1 : 0;
}

/**
 * Claude Code PostToolUse hook. Reads the hook JSON on stdin, fixes + lints the edited file.
 * Exit 2 sends stderr back to the agent so it fixes what it broke.
 * @param {string} cwd
 */
export async function agentHook(cwd) {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  /** @type {string | undefined} */
  let file;
  try {
    const input = JSON.parse(raw || '{}');
    file = input.tool_input?.file_path ?? input.tool_input?.path;
  } catch {
    return 0;
  }
  if (!file) {
    return 0;
  }
  const ctx = loadContext(cwd);
  const rel = path.relative(ctx.root, path.resolve(cwd, file));
  if (rel.startsWith('..')) {
    return 0;
  }
  const lang = getLanguages(profile(ctx)).find((l) => matches(l, rel));
  if (!lang) {
    return 0;
  }
  for (const step of lang.steps) {
    if (runStep(step, { mode: 'fix', files: [rel], cwd: ctx.root }) !== 0) {
      log(
        red(`star-config: ${step.tool} reported problems in ${rel}. Fix them before continuing.`),
      );
      return 2;
    }
  }
  return 0;
}

/**
 * @param {Context} ctx
 */
export function doctor(ctx) {
  log(bold(`star-config ${version()}${IS_SEA ? ' (binary)' : ''}`));
  log(`Repo:     ${ctx.repoName}`);
  log(`Detected: ${describeStacks(ctx.stacks).join(' · ') || 'nothing'}`);
  let missing = 0;
  /** @type {Set<string>} */
  const seen = new Set();
  const report1 = (/** @type {import('./languages.js').Step} */ step) => {
    if (seen.has(step.tool)) {
      return;
    }
    seen.add(step.tool);
    const ok = resolveTool(step, ctx.root);
    if (!ok) {
      missing++;
    }
    const hint = ok ? '' : dim(`  → ${step.install}`);
    log(`  ${ok ? green('✔') : yellow('✖')} ${step.tool}${hint}`);
  };
  for (const { lang, files } of filesByLanguage(ctx)) {
    const count = dim(`(${files.length} files)`);
    log(`${lang.label} ${count}`);
    lang.steps.forEach(report1);
  }
  const tasks = [
    ...testTasks(ctx.stacks, ctx.files, { cwd: ctx.root, e2e: true }),
    ...buildTasks(ctx.stacks, ctx.files, { cwd: ctx.root }),
    ...auditTasks(ctx.stacks, ctx.files, { cwd: ctx.root }),
  ].filter((t) => !t.fn);
  log('Test / build / audit');
  for (const t of tasks) {
    report1({
      tool: t.tool,
      npm: t.npm,
      venv: t.venv,
      fallbacks: t.fallbacks,
      args: {},
      install: t.install,
    });
  }
  const miseFile = path.join(ctx.root, 'mise.toml');
  if (existsSync(miseFile)) {
    const text = readFileSync(miseFile, 'utf8');
    const drift = miseToolsFor(ctx.stacks).filter((t) => !text.includes(`= "${MISE_TOOLS[t]}"`));
    if (drift.length) {
      log(
        yellow(
          `⚠ mise.toml is behind star-config ${version()} for: ${drift.join(', ')} → run \`star-config sync\``,
        ),
      );
    }
  }
  log(
    missing
      ? yellow(
          `\n${missing} tool(s) missing — skipped locally, enforced in CI. \`star-config setup\` installs them.`,
        )
      : green('\nAll tools available.'),
  );
  return missing && isStrict() ? 1 : 0;
}

/**
 * Re-render managed files from the current templates and pins.
 * @param {Context} ctx
 * @param {{ force?: boolean, dryRun?: boolean }} opts
 */
export async function sync(ctx, { force = false, dryRun = false }) {
  const r = await converge(ctx.root, () => loadContext(ctx.root), {
    force,
    version: version(),
    dryRun,
  });
  report(r);
  if (dryRun && (r.written.length || r.updated.length)) {
    log(yellow('Managed files are out of date. Run `star-config sync`.'));
    return 1;
  }
  return 0;
}

/**
 * @param {string} cwd
 * @param {{ force?: boolean, scaffold?: boolean, install?: boolean, owners?: string[], securityContact?: string, jsProfile?: 'eslint' | 'biome' }} opts
 */
export async function setup(cwd, opts) {
  const overrides = {
    owners: opts.owners,
    securityContact: opts.securityContact,
    jsProfile: opts.jsProfile,
  };
  const ctx = loadContext(cwd, overrides);
  if (opts.owners || opts.securityContact || opts.jsProfile) {
    mkdirSync(path.join(ctx.root, '.star'), { recursive: true });
    const file = '.star/config.json';
    writeFileSync(
      path.join(ctx.root, file),
      await formatGenerated(file, JSON.stringify(ctx.config)),
    );
  }
  return runSetup(ctx, opts);
}

export { installHooks, sonar };
