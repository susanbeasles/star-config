#!/usr/bin/env node
// @ts-check
import { parseArgs } from 'node:util';
import { initialize } from '../src/initialize.js';
import { version } from '../src/assets.js';
import {
  agentHook,
  audit,
  build,
  check,
  doctor,
  installHooks,
  lint,
  preCommit,
  prePush,
  run,
  setup,
  sonar,
  sync,
  test,
} from '../src/commands.js';
import { loadContext } from '../src/context.js';

const HELP = `star-config ${version()} — lint · format · test · build · audit, for every stack in the repo

Setup
  init                          Initialize project tooling (also runs after package installation)
  setup [--owners @org/team] [--security-contact x@y] [--profile eslint|biome] [--force] [--no-install] [--no-scaffold]
  sync [--check] [--force]      Re-render managed files and tool pins (safe: keeps files you edited)
  hooks                         (Re)install git hooks
  doctor                        Detected stacks, installed/missing tools, drift

Daily
  lint [--fix]                  All linters + format checks (read-only unless --fix)
  format                        Formatters only (writes)
  test [--e2e] [--coverage]     Vitest/Playwright · pytest · cargo test · swift test · bats
  build [--docker]              esbuild/npm build · uv build · cargo · swift · docker buildx
  audit                         gitleaks · trivy · semgrep · npm/pip-audit · cargo-deny · cdk-nag · wrangler-nag
  check [--coverage] [--e2e]    lint + test + audit (what CI runs)

Extras
  sonar up|scan|status|down [--purge]   Local SonarQube in Docker (127.0.0.1:9000)

Internal (hooks)
  pre-commit · pre-push · agent-hook · run <lang> [--check] <files…>

Env: CI=true or STAR_CONFIG_STRICT=1 → missing tools fail instead of warn.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fix: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    e2e: { type: 'boolean', default: false },
    coverage: { type: 'boolean', default: false },
    docker: { type: 'boolean', default: false },
    purge: { type: 'boolean', default: false },
    'no-install': { type: 'boolean', default: false },
    'no-scaffold': { type: 'boolean', default: false },
    owners: { type: 'string' },
    'security-contact': { type: 'string' },
    profile: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
  },
});

const [command, ...rest] = positionals;
const cwd = process.cwd();

/** @returns {Promise<number>} */
async function main() {
  if (values.version || command === 'version') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (values.help || !command || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const ctx = () => loadContext(cwd);
  switch (command) {
    case 'init':
      await initialize(cwd, { requireDependency: false });
      return 0;
    case 'setup': {
      const prof = values.profile;
      if (prof && prof !== 'eslint' && prof !== 'biome') {
        throw new Error('--profile must be eslint or biome');
      }
      return setup(cwd, {
        force: values.force,
        install: !values['no-install'],
        scaffold: !values['no-scaffold'],
        owners: values.owners?.split(/[\s,]+/).filter(Boolean),
        securityContact: values['security-contact'],
        jsProfile: /** @type {'eslint' | 'biome' | undefined} */ (prof),
      });
    }
    case 'sync':
      return sync(loadContext(cwd, {}, true), { force: values.force, dryRun: values.check });
    case 'hooks':
      return installHooks(ctx());
    case 'doctor':
      return doctor(ctx());
    case 'lint':
      return lint(ctx(), { fix: values.fix });
    case 'format':
      return lint(ctx(), { formatOnly: true });
    case 'test':
      return test(ctx(), { e2e: values.e2e, coverage: values.coverage });
    case 'build':
      return build(ctx(), { docker: values.docker });
    case 'audit':
      return audit(ctx());
    case 'check':
      return check(ctx(), { coverage: values.coverage, e2e: values.e2e });
    case 'sonar':
      return sonar(rest[0] ?? '', { cwd, purge: values.purge });
    case 'pre-commit':
      return preCommit(ctx());
    case 'pre-push':
      return prePush(ctx());
    case 'agent-hook':
      return agentHook(cwd);
    case 'run': {
      const [lang, ...files] = rest;
      if (!lang) {
        throw new Error('Usage: star-config run <lang> [--check] <files...>');
      }
      return run(lang, files, { cwd, check: values.check });
    }
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}\n`);
      return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
