// @ts-check
/**
 * Repo-level tasks: test, build, audit. Each is derived from detected stacks.
 *
 * @typedef {import('./detect.js').Stacks} Stacks
 *
 * @typedef {object} Task
 * @property {string} id                     e.g. "python:pytest"
 * @property {string} tool
 * @property {string[]} args
 * @property {{ pkg: string, bin?: string }} [npm]
 * @property {boolean} [venv]
 * @property {string[][]} [fallbacks]
 * @property {string} install
 * @property {(ctx: { cwd: string, env: NodeJS.ProcessEnv }) => number} [fn]  Built-in task (no external tool).
 * @property {number[]} [okCodes]            Extra exit codes treated as success.
 * @property {Record<string, string>} [env]   Extra environment for the tool.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assetPath } from './assets.js';
import { MISE_TOOLS, PY_DEV } from './tools.js';
import { wranglerNag } from './wrangler-nag.js';

const MISE = (/** @type {string} */ t) => `star-config setup  |  mise use ${t}`;

/** @param {'npm' | 'pnpm' | 'yarn' | 'bun'} pm */
const pmTask = (pm) => ({ tool: pm, install: `install ${pm}` });

/**
 * @param {string} cwd
 */
function readPkg(cwd) {
  try {
    return JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * @param {'npm' | 'pnpm' | 'yarn' | 'bun'} pm
 * @param {string[]} files
 * @param {{ cwd: string, e2e: boolean, coverage: boolean }} opts
 * @returns {Task[]}
 */
function nodeTestTasks(pm, files, { cwd, e2e, coverage }) {
  /** @type {Task[]} */
  const tasks = [];
  const pkg = readPkg(cwd);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hasUnitTests = files.some(
    (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) && !/(^|\/)e2e\//.test(f),
  );
  const script = pkg.scripts?.test ?? '';
  if (deps.vitest && hasUnitTests) {
    tasks.push({
      id: 'node:vitest',
      tool: 'vitest',
      npm: { pkg: 'vitest' },
      args: ['run', ...(coverage ? ['--coverage'] : [])],
      install: 'star-config setup',
    });
  } else if (script && !/no test specified|star-config/.test(script)) {
    // A custom test script (never our own `star-config test`, which would recurse).
    tasks.push({ id: 'node:test', ...pmTask(pm), args: ['run', 'test'] });
  }
  const pwConfig = files.some((f) => /^playwright\.config\.[cm]?[jt]s$/.test(f));
  if (e2e && deps['@playwright/test'] && pwConfig) {
    tasks.push({
      id: 'node:playwright',
      tool: 'playwright',
      npm: { pkg: '@playwright/test', bin: 'playwright' },
      args: ['test'],
      install: 'star-config setup',
    });
  }
  return tasks;
}

/**
 * @param {Stacks} stacks
 * @param {string[]} files
 * @param {{ cwd: string, e2e?: boolean, coverage?: boolean }} opts
 * @returns {Task[]}
 */
export function testTasks(stacks, files, { cwd, e2e = false, coverage = false }) {
  /** @type {Task[]} */
  const tasks = stacks.node ? nodeTestTasks(stacks.node.pm, files, { cwd, e2e, coverage }) : [];
  if (stacks.python && files.some((f) => /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(f))) {
    tasks.push({
      id: 'python:pytest',
      // `python -m pytest` puts the repo root on sys.path (plain `pytest` doesn't).
      tool: 'python',
      venv: true,
      fallbacks: [['python3'], ['uv', 'run', 'python']],
      args: [
        '-m',
        'pytest',
        '-q',
        ...(coverage ? ['--cov', '--cov-report=term-missing', '--cov-report=xml'] : []),
      ],
      install: 'star-config setup  (creates .venv with pytest)',
    });
  }
  if (stacks.rust) {
    tasks.push({
      id: 'rust:cargo-test',
      tool: 'cargo',
      args: ['test', '--all-features', ...(files.includes('Cargo.lock') ? ['--locked'] : [])],
      install: 'https://rustup.rs',
    });
  }
  if (stacks.swift?.spm) {
    tasks.push({
      id: 'swift:test',
      tool: 'swift',
      args: ['test'],
      install: 'Install Xcode or a Swift toolchain',
    });
  }
  const batsDirs = [
    ...new Set(files.filter((f) => f.endsWith('.bats')).map((f) => path.posix.dirname(f))),
  ];
  if (batsDirs.length) {
    tasks.push({
      id: 'shell:bats',
      tool: 'bats',
      args: ['-r', ...batsDirs],
      install: MISE('bats'),
    });
  }
  return tasks;
}

/**
 * @param {Stacks} stacks
 * @param {string[]} files
 * @param {{ cwd: string, docker?: boolean }} opts
 * @returns {Task[]}
 */
export function buildTasks(stacks, files, { cwd, docker = false }) {
  /** @type {Task[]} */
  const tasks = [];
  if (stacks.node) {
    const entry = ['src/index.ts', 'src/index.mts', 'src/index.js', 'src/index.mjs'].find((f) =>
      files.includes(f),
    );
    if (stacks.node.hasBuild) {
      tasks.push({ id: 'node:build', ...pmTask(stacks.node.pm), args: ['run', 'build'] });
    } else if (entry && !stacks.node.web && !stacks.node.reactNative) {
      tasks.push({
        id: 'node:esbuild',
        tool: 'esbuild',
        npm: { pkg: 'esbuild' },
        args: [
          entry,
          '--bundle',
          '--platform=node',
          '--target=node24',
          '--format=esm',
          '--sourcemap',
          '--packages=external',
          '--outdir=dist',
        ],
        install: 'star-config setup',
      });
    }
  }
  if (stacks.python?.hasPyproject) {
    tasks.push({ id: 'python:uv-build', tool: 'uv', args: ['build'], install: MISE('uv') });
  }
  if (stacks.rust) {
    tasks.push({
      id: 'rust:cargo-build',
      tool: 'cargo',
      args: ['build', '--release', ...(files.includes('Cargo.lock') ? ['--locked'] : [])],
      install: 'https://rustup.rs',
    });
  }
  if (stacks.swift?.spm) {
    tasks.push({
      id: 'swift:build',
      tool: 'swift',
      args: ['build', '-c', 'release'],
      install: 'Install Xcode or a Swift toolchain',
    });
  }
  if (docker && stacks.docker) {
    for (const file of stacks.docker.files) {
      const name = path
        .basename(cwd)
        .toLowerCase()
        .replaceAll(/[^a-z0-9._-]/g, '-');
      tasks.push({
        id: `docker:${file}`,
        tool: 'docker',
        args: [
          'buildx',
          'build',
          '--load',
          '-f',
          file,
          '-t',
          `${name}:dev`,
          path.posix.dirname(file),
        ],
        install: 'https://docs.docker.com/get-docker/',
      });
    }
  }
  return tasks;
}

/** @param {string} cwd */
function semgrepConfigs(cwd) {
  const override = process.env.STAR_SEMGREP_CONFIG;
  if (override) {
    return override.split(',').flatMap((c) => ['--config', c]);
  }
  const local = ['.semgrep.yml', '.semgrep.yaml', '.semgrep'].find((f) =>
    existsSync(path.join(cwd, f)),
  );
  return ['--config', 'p/default', ...(local ? ['--config', local] : [])];
}

/**
 * @param {Stacks} stacks
 * @param {string[]} files
 * @param {{ cwd: string }} opts
 * @returns {Task[]}
 */
export function auditTasks(stacks, files, { cwd }) {
  /** @type {Task[]} */
  const tasks = [
    {
      id: 'secrets:gitleaks',
      tool: 'gitleaks',
      args: ['git', '--redact', '--verbose', '--no-banner'],
      install: MISE('gitleaks'),
    },
    {
      id: 'deps+iac:trivy',
      tool: 'trivy',
      args: [
        'fs',
        '--scanners',
        'vuln,misconfig',
        '--severity',
        'HIGH,CRITICAL',
        '--ignore-unfixed',
        '--exit-code',
        '1',
        '--skip-dirs',
        'node_modules,.venv,target,cdk.out',
        '--quiet',
        '.',
      ],
      install: MISE('trivy'),
    },
    {
      id: 'sast:semgrep',
      tool: 'semgrep',
      // No telemetry, no version pings: source never leaves the machine except rule downloads.
      env: { SEMGREP_ENABLE_VERSION_CHECK: '0', SEMGREP_SEND_METRICS: 'off' },
      args: [
        'scan',
        ...semgrepConfigs(cwd),
        '--error',
        '--metrics',
        'off',
        '--quiet',
        '--exclude',
        'node_modules',
        '--exclude',
        '.venv',
      ],
      install: MISE('semgrep'),
    },
  ];
  if (stacks.node) {
    const pm = stacks.node.pm;
    /** @type {Record<string, string[]>} */
    const auditArgs = {
      npm: ['audit', '--audit-level=high'],
      pnpm: ['audit', '--audit-level', 'high'],
      yarn: ['npm', 'audit', '--severity', 'high', '--recursive'],
      bun: ['audit', '--audit-level=high'],
    };
    if (
      files.some((f) => /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(f))
    ) {
      tasks.push({ id: `node:${pm}-audit`, ...pmTask(pm), args: auditArgs[pm] });
    }
    if (stacks.node.cdk && files.includes('cdk.json')) {
      // cdk-nag runs as an Aspect during synth (see AGENTS.md / README for the 3-line wiring).
      tasks.push({
        id: 'iac:cdk-nag',
        tool: 'cdk',
        npm: { pkg: 'aws-cdk', bin: 'cdk' },
        args: ['synth', '--quiet'],
        install: 'npm i -D aws-cdk',
      });
    }
  }
  if (stacks.python) {
    tasks.push({
      id: 'python:pip-audit',
      tool: 'pip-audit',
      venv: true,
      fallbacks: [['uvx', `pip-audit@${PY_DEV['pip-audit']}`]],
      args:
        files.includes('requirements.txt') && !existsSync(path.join(cwd, '.venv'))
          ? ['-r', 'requirements.txt']
          : [],
      install: 'star-config setup',
    });
  }
  if (stacks.rust) {
    tasks.push({
      id: 'rust:cargo-deny',
      tool: 'cargo-deny',
      args: [
        ...(existsSync(path.join(cwd, 'deny.toml'))
          ? []
          : ['--config', assetPath('configs/deny.toml')]),
        'check',
      ],
      install: MISE('cargo-deny'),
    });
  }
  if (stacks.terraform) {
    tasks.push({
      id: 'iac:checkov',
      tool: 'checkov',
      fallbacks: [['uvx', `checkov@${MISE_TOOLS.checkov}`]],
      // --skip-download: never contact the Prisma Cloud API; OSS policies only.
      args: [
        '--directory',
        '.',
        '--framework',
        'terraform',
        '--compact',
        '--quiet',
        '--skip-download',
        '--skip-path',
        '.terraform',
      ],
      env: { BC_SKIP_MAPPING: 'TRUE', CHECKOV_RUN_SCA_PACKAGE_SCAN_V2: 'false' },
      install: MISE('checkov'),
    });
  }
  if (stacks.cloudflare) {
    const wranglerFiles = stacks.cloudflare.files;
    tasks.push({
      id: 'iac:wrangler-nag',
      tool: 'star-config',
      args: [],
      install: '',
      fn: (ctx) => wranglerNag(wranglerFiles, ctx.cwd),
    });
  }
  return tasks;
}
