// @ts-check
/**
 * `star-config setup`: detect → scaffold → install per-stack deps → mise tools → git hooks.
 * Every install step is idempotent and skipped (with a hint) when its tool is missing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readManaged, writeManaged, validatePackageInputs } from './managed-files.js';
import { GUARD, HOOKS, validateHostPath } from './hook-boundary.js';
import { IS_SEA, version } from './assets.js';
import { NPM_NAME } from './constants.js';
import { describeStacks } from './detect.js';
import { loadContext } from './context.js';
import { converge, report } from './scaffold.js';
import { NPM_DEV, PY_DEV } from './tools.js';
import { bold, dim, exec, green, log, yellow } from './runner.js';

/** @typedef {import('./context.js').Context} Context */

/** @param {string} cmd */
const has = (cmd) => !spawnSync(cmd, ['--version'], { stdio: 'ignore' }).error;

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} what
 */
function step(cmd, args, cwd, what) {
  log(dim(`  $ ${cmd} ${args.join(' ')}`));
  const code = exec(cmd, args, { cwd });
  if (code !== 0) {
    log(yellow(`  ⚠ ${what} failed (exit ${code}); continuing`));
  }
  return code;
}

/**
 * npm devDependencies this repo should have (only ones not already present).
 * @param {Context} ctx
 */
export function npmPackagesToAdd(ctx) {
  validatePackageInputs(ctx.root);
  const node = ctx.stacks.node;
  if (!node) {
    return [];
  }
  const pkg = JSON.parse(readManaged(ctx.root, 'package.json') ?? '{}');
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  /** @type {string[]} */
  const want = [NPM_NAME];
  if (node.typescript) {
    want.push('typescript');
  }
  if (!node.reactNative) {
    want.push('vitest', '@vitest/coverage-v8');
  }
  if (node.web) {
    want.push('@playwright/test');
  }
  if (!node.hasBuild && !node.web && !node.reactNative) {
    want.push('esbuild');
  }
  if (node.cdk) {
    want.push('cdk-nag');
  }
  return want
    .filter((name) => !Object.hasOwn(deps, name))
    .map((name) => {
      if (name === NPM_NAME) {
        // Override for private mirrors / testing unreleased builds (e.g. file:../star-config.tgz).
        return process.env.STAR_CONFIG_NPM_SPEC ?? `${NPM_NAME}@${version()}`;
      }
      return `${name}@${NPM_DEV[/** @type {keyof typeof NPM_DEV} */ (name)]}`;
    });
}

/** @param {Context} ctx */
function warnTypeScript7(ctx) {
  const pkg = JSON.parse(readManaged(ctx.root, 'package.json') ?? '{}');
  const ts = pkg.devDependencies?.typescript ?? pkg.dependencies?.typescript;
  if (ts && /^\D*7/.test(ts)) {
    log(
      yellow(
        '  ⚠ typescript 7 detected: typescript-eslint/sonarjs need TypeScript < 6.1. Pin typescript@6.0.3 for linting.',
      ),
    );
  }
}

/** @param {Context} ctx */
function installNode(ctx) {
  const node = /** @type {NonNullable<Context['stacks']['node']>} */ (ctx.stacks.node);
  warnTypeScript7(ctx);
  const add = npmPackagesToAdd(ctx);
  /** @type {Record<string, [string, string[]]>} */
  const cmds = {
    npm: ['npm', ['install', '--save-dev', '--save-exact', ...add]],
    pnpm: ['pnpm', ['add', '--save-dev', '--save-exact', ...add]],
    yarn: ['yarn', ['add', '--dev', '--exact', ...add]],
    bun: ['bun', ['add', '--dev', '--exact', ...add]],
  };
  if (add.length) {
    const [cmd, args] = cmds[node.pm];
    step(cmd, args, ctx.root, `${node.pm} install`);
  }
  const pkg = JSON.parse(readManaged(ctx.root, 'package.json') ?? '{}');
  pkg.scripts ??= {};
  const scripts = {
    lint: 'star-config lint',
    'lint:fix': 'star-config lint --fix',
    format: 'star-config format',
    audit: 'star-config audit',
    check: 'star-config check',
  };
  let changed = false;
  for (const [k, v] of Object.entries(scripts)) {
    if (!pkg.scripts[k]) {
      pkg.scripts[k] = v;
      changed = true;
    }
  }
  if (!pkg.scripts.test || /no test specified/.test(pkg.scripts.test)) {
    pkg.scripts.test = 'star-config test';
    changed = true;
  }
  if (changed) {
    writeManaged(ctx.root, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
    log(`  ${green('update')} package.json scripts`);
  }
}

/** @param {Context} ctx */
function installPython(ctx) {
  const py = /** @type {NonNullable<Context['stacks']['python']>} */ (ctx.stacks.python);
  const dev = Object.entries(PY_DEV).map(([n, v]) => `${n}==${v}`);
  if (py.manager === 'poetry') {
    if (has('poetry')) {
      step('poetry', ['add', '--group', 'dev', ...dev], ctx.root, 'poetry add');
    }
    return;
  }
  if (!has('uv')) {
    log(yellow('  ⚠ uv not found: install it (mise install) to get the .venv'));
    return;
  }
  if (!existsSync(path.join(ctx.root, '.venv'))) {
    // "a venv with your name on it"
    step('uv', ['venv', '--prompt', ctx.repoName, '.venv'], ctx.root, 'uv venv');
  }
  if (py.hasPyproject) {
    step('uv', ['add', '--dev', ...dev], ctx.root, 'uv add --dev');
  } else {
    if (readManaged(ctx.root, 'requirements.txt') !== null) {
      step(
        'uv',
        ['pip', 'install', '--python', '.venv', '-r', 'requirements.txt'],
        ctx.root,
        'install requirements',
      );
    }
    step('uv', ['pip', 'install', '--python', '.venv', ...dev], ctx.root, 'install dev tools');
  }
}

/** @param {Context} ctx */
function installRust(ctx) {
  if (has('rustup')) {
    step('rustup', ['component', 'add', 'rustfmt', 'clippy'], ctx.root, 'rustup components');
  }
}

/** @param {Context} ctx */
function installMise(ctx) {
  if (!has('mise')) {
    log(yellow('  ⚠ mise not found — native tools (gitleaks, trivy, semgrep…) not installed.'));
    log(dim('    Install: https://mise.jdx.dev/getting-started.html  then re-run setup.'));
    return;
  }
  step('mise', ['trust', '--yes', path.join(ctx.root, 'mise.toml')], ctx.root, 'mise trust');
  step('mise', ['install', '--yes'], ctx.root, 'mise install');
  step(
    'mise',
    ['lock', '--platform', 'linux-x64,linux-arm64,macos-x64,macos-arm64'],
    ctx.root,
    'mise lock',
  );
}

/** @param {Context} ctx */
function assertNoHuskyPrepare(ctx) {
  const contents = readManaged(ctx.root, 'package.json');
  if (contents !== null) {
    const pkg = JSON.parse(contents);
    const prepare = pkg.scripts?.prepare;
    if (prepare && /\bhusky\b/.test(prepare)) {
      throw new Error(
        'package.json prepare invokes Husky and was preserved. Explicitly migrate/remove that hook installer before rerunning star-config hooks.',
      );
    }
  }
}

function validateHostInstallation() {
  try {
    validateHostPath(GUARD);
    validateHostPath(HOOKS, true);
    for (const hook of ['pre-commit', 'pre-push']) {
      validateHostPath(path.join(HOOKS, hook));
    }
  } catch (error) {
    throw new Error(
      `Host agent-guard installation is unavailable or unsafe. Ask the host administrator to install the reviewed runner and Git hooks; no checkout fallback is permitted. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** @param {Context} ctx */
export function installHooks(ctx) {
  const config = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: ctx.root,
    encoding: 'utf8',
  });
  if (config.status !== 0 && config.status !== 1) {
    throw new Error('Cannot inspect Git hook configuration; no hooks were installed.');
  }
  const existing = config.stdout.trim();
  if (existing && existing !== HOOKS) {
    throw new Error(
      `Existing core.hooksPath=${existing} was preserved. Review and migrate its checks into host agent-guard policy, then explicitly remove the old setting and rerun star-config hooks.`,
    );
  }
  if (!existing) {
    const result = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: ctx.root,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error('Cannot locate existing Git hooks.');
    }
    const dir = path.resolve(ctx.root, result.stdout.trim());
    if (existsSync(dir) && readdirSync(dir).some((name) => !name.endsWith('.sample'))) {
      throw new Error(
        'Existing Git hooks were preserved. Migrate their checks into host agent-guard policy before installing managed hooks.',
      );
    }
  }
  validateHostInstallation();
  assertNoHuskyPrepare(ctx);
  return step('git', ['config', '--local', 'core.hooksPath', HOOKS], ctx.root, 'host Git hooks');
}

/**
 * @param {Context} initial
 * @param {{ force?: boolean, scaffold?: boolean, install?: boolean }} opts
 */
export async function setup(initial, { force = false, scaffold = true, install = true }) {
  let ctx = initial;
  // Refuse before dependency installs can run an existing Husky lifecycle script.
  assertNoHuskyPrepare(ctx);
  validateHostInstallation();
  log(bold(`star-config ${version()}${IS_SEA ? ' (binary)' : ''} — ${ctx.repoName}`));
  log(`Detected: ${describeStacks(ctx.stacks).join(' · ') || 'nothing yet'}`);
  if (scaffold) {
    log(bold('\nFiles'));
    report(
      await converge(ctx.root, () => loadContext(ctx.root, {}, true), {
        force,
        version: version(),
      }),
    );
  }
  ctx = loadContext(ctx.root, {}, true);
  if (install) {
    log(bold('\nInstall'));
    if (ctx.stacks.node) {
      installNode(ctx);
    }
    if (ctx.stacks.python) {
      installPython(ctx);
    }
    if (ctx.stacks.rust) {
      installRust(ctx);
    }
    installMise(ctx);
  }
  log(bold('\nHooks'));
  const hooksCode = installHooks(ctx);
  if (hooksCode !== 0) {
    return hooksCode;
  }
  if (ctx.stacks.node?.cdk) {
    log(`\n${bold('AWS CDK:')} wire cdk-nag into your app entry (bin/*.ts):
  ${dim("import { Aspects } from 'aws-cdk-lib';")}
  ${dim("import { AwsSolutionsChecks, HIPAASecurityChecks } from 'cdk-nag';")}
  ${dim('Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));')}
  ${dim('Aspects.of(app).add(new HIPAASecurityChecks({ verbose: true }));')}`);
  }
  log(green('\n✔ Ready. Try: .star/run doctor   ·   .star/run check'));
  return 0;
}
