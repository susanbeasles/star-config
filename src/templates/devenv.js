// @ts-check
import { guardCommand } from '../hook-boundary.js';
import { INSTALL_URL } from '../constants.js';
import { MISE_TOOLS } from '../tools.js';

/** @typedef {import('./governance.js').Ctx} Ctx */

/**
 * Native tools this repo needs, pinned from star-config's tool table.
 * @param {Ctx['stacks']} s
 * @returns {Array<keyof typeof MISE_TOOLS>}
 */
export function miseToolsFor(s) {
  /** @type {Array<keyof typeof MISE_TOOLS>} */
  const tools = ['gitleaks', 'trivy', 'uv', 'semgrep'];
  if (s.yaml || s.githubActions) {
    tools.push('yamllint');
  }
  if (s.githubActions) {
    tools.push('actionlint');
  }
  if (s.shell) {
    tools.push('shellcheck', 'shfmt', 'bats');
  }
  if (s.docker) {
    tools.push('hadolint');
  }
  if (s.python) {
    tools.push('ruff');
  }
  if (s.rust) {
    tools.push('cargo-deny');
  }
  if (s.swift) {
    tools.push('swiftlint');
  }
  if (s.terraform) {
    tools.push('tflint', 'checkov');
  }
  return tools;
}

/** @param {Ctx} ctx */
export function miseToml(ctx) {
  const lines = miseToolsFor(ctx.stacks).map((t) => {
    const key = t.includes('-') ? JSON.stringify(t) : t;
    return `${key} = "${MISE_TOOLS[t]}"`;
  });
  return `# Managed by star-config v${ctx.version}: pinned native tools for this repo.
# Install: \`mise install\` (setup does this). Update: bump star-config, then \`star-config sync\`.
# mise.lock records per-platform URLs + checksums; commit it.
[settings]
lockfile = true

[tools]
${lines.join('\n')}
`;
}

/** The single launcher used by git hooks, agent hooks, CI and humans. */
export function launcher() {
  return `#!/bin/sh
# Managed by star-config. Resolves the repo-pinned star-config first, then the global one.
set -eu
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
if [ -x "$root/node_modules/.bin/star-config" ]; then
  exec "$root/node_modules/.bin/star-config" "$@"
fi
if command -v star-config >/dev/null 2>&1; then
  exec star-config "$@"
fi
echo "star-config is not installed." >&2
echo "  curl -fsSL ${INSTALL_URL} | sh      # any repo" >&2
echo "  npm i -D star-config        # Node repos" >&2
exit 127
`;
}

/** @param {'pre-commit' | 'pre-push'} hook */
export function gitHook(hook) {
  return `#!/bin/sh
# Managed by star-config (${hook}). Bypassing with --no-verify is visible in review and CI still enforces.
${guardCommand(hook)}
`;
}

/** @param {Ctx} ctx */
export function devcontainerJson(ctx) {
  const s = ctx.stacks;
  /** @type {Record<string, object>} */
  const features = { 'ghcr.io/devcontainers/features/github-cli:1': {} };
  if (s.node) {
    features['ghcr.io/devcontainers/features/node:1'] = { version: '24' };
  }
  if (s.python) {
    features['ghcr.io/devcontainers/features/python:1'] = { version: '3.13', installTools: false };
  }
  if (s.rust) {
    features['ghcr.io/devcontainers/features/rust:1'] = { profile: 'default' };
  }
  features['ghcr.io/devcontainers/features/docker-in-docker:2'] = {};
  return `${JSON.stringify(
    {
      name: ctx.repoName,
      image: 'mcr.microsoft.com/devcontainers/base:ubuntu-24.04',
      features,
      postCreateCommand: 'bash .devcontainer/post-create.sh',
      customizations: { vscode: { extensions: vscodeExtensions(ctx) } },
      forwardPorts: s.node?.web ? [5173, 3000] : [],
    },
    null,
    2,
  )}\n`;
}

export function postCreateSh() {
  return `#!/usr/bin/env bash
# Managed by star-config: provisions a Codespace / devcontainer.
set -euo pipefail
if ! command -v mise >/dev/null 2>&1; then
  curl -fsSL https://mise.run | sh
  # shellcheck disable=SC2016 # expanded later by the interactive shell, on purpose
  echo 'eval "$(~/.local/bin/mise activate bash)"' >>~/.bashrc
  export PATH="$HOME/.local/bin:$PATH"
fi
mise trust --yes
mise install --yes
if [[ -f package.json ]]; then
  npm ci --no-audit --no-fund
fi
if [[ ! -x node_modules/.bin/star-config ]] && ! command -v star-config >/dev/null 2>&1; then
  curl -fsSL ${INSTALL_URL} | sh
fi
.star/run setup --no-scaffold
`;
}

/** @param {Ctx} ctx */
export function vscodeExtensions(ctx) {
  const s = ctx.stacks;
  const ext = [
    'SonarSource.sonarlint-vscode',
    'EditorConfig.EditorConfig',
    'redhat.vscode-yaml',
    'github.vscode-github-actions',
  ];
  if (s.node) {
    ext.push(
      ...(s.node.lintProfile === 'biome' ? ['biomejs.biome'] : ['dbaeumer.vscode-eslint']),
      'esbenp.prettier-vscode',
      'vitest.explorer',
    );
    if (s.node.web) {
      ext.push('ms-playwright.playwright');
    }
  }
  if (s.python) {
    ext.push('ms-python.python', 'charliermarsh.ruff');
  }
  if (s.rust) {
    ext.push('rust-lang.rust-analyzer');
  }
  if (s.swift) {
    ext.push('swiftlang.swift-vscode');
  }
  if (s.shell) {
    ext.push('timonwong.shellcheck', 'mkhl.shfmt', 'jetmartin.bats');
  }
  if (s.docker) {
    ext.push('ms-azuretools.vscode-containers', 'exiasr.hadolint');
  }
  if (s.terraform) {
    ext.push('hashicorp.terraform');
  }
  return ext;
}

/** @param {Ctx} ctx */
export function vscodeSettings(ctx) {
  const s = ctx.stacks;
  const jsFormatter = s.node?.lintProfile === 'biome' ? 'biomejs.biome' : 'esbenp.prettier-vscode';
  /** @type {Record<string, unknown>} */
  const settings = {
    'editor.formatOnSave': true,
    'files.insertFinalNewline': true,
    'files.trimTrailingWhitespace': true,
  };
  for (const lang of [
    'javascript',
    'javascriptreact',
    'typescript',
    'typescriptreact',
    'json',
    'jsonc',
  ]) {
    settings[`[${lang}]`] = { 'editor.defaultFormatter': jsFormatter };
  }
  for (const lang of ['markdown', 'yaml', 'html', 'css', 'scss']) {
    settings[`[${lang}]`] = { 'editor.defaultFormatter': 'esbenp.prettier-vscode' };
  }
  settings['editor.codeActionsOnSave'] =
    s.node?.lintProfile === 'biome'
      ? { 'source.fixAll.biome': 'explicit', 'source.organizeImports.biome': 'explicit' }
      : { 'source.fixAll.eslint': 'explicit' };
  if (s.python) {
    settings['[python]'] = {
      'editor.defaultFormatter': 'charliermarsh.ruff',
      'editor.codeActionsOnSave': { 'source.fixAll.ruff': 'explicit' },
    };
    settings['python.defaultInterpreterPath'] = '${workspaceFolder}/.venv/bin/python';
  }
  if (s.rust) {
    settings['[rust]'] = { 'editor.defaultFormatter': 'rust-lang.rust-analyzer' };
    settings['rust-analyzer.check.command'] = 'clippy';
  }
  if (s.shell) {
    settings['[shellscript]'] = { 'editor.defaultFormatter': 'mkhl.shfmt' };
  }
  settings['sonarlint.connectedMode.connections.sonarqube'] = [
    { serverUrl: 'http://127.0.0.1:9000', connectionId: 'local' },
  ];
  return `${JSON.stringify(settings, null, 2)}\n`;
}

const SETUP_NODE = `      - uses: actions/setup-node@v5 # TODO pin to SHA
        with:
          node-version: 24
`;

/** @type {Record<'npm' | 'pnpm' | 'yarn' | 'bun', string>} */
const NODE_CI_STEPS = {
  npm: `${SETUP_NODE}          cache: npm
      - run: npm ci
`,
  pnpm: `      - uses: pnpm/action-setup@v4 # TODO pin to SHA
${SETUP_NODE}          cache: pnpm
      - run: pnpm install --frozen-lockfile
`,
  yarn: `${SETUP_NODE}          cache: yarn
      - run: yarn install --immutable
`,
  bun: `      - uses: oven-sh/setup-bun@v2 # TODO pin to SHA
      - run: bun install --frozen-lockfile
`,
};

/** @param {string} version */
const binaryInstall = (version) => `      - name: Install star-config (checksum-verified)
        run: curl -fsSL ${INSTALL_URL} | sh -s -- --version ${version}
`;

/** @param {Ctx} ctx */
export function githubWorkflow(ctx) {
  const s = ctx.stacks;
  const nodeSteps = s.node ? NODE_CI_STEPS[s.node.pm] : binaryInstall(ctx.version);
  const e2e = s.node?.web
    ? `
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v5 # TODO pin to SHA
        with:
          persist-credentials: false
      - uses: actions/setup-node@v5 # TODO pin to SHA
        with:
          node-version: 24
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: .star/run test --e2e
`
    : '';
  return `# Managed by star-config. Pin every action to a full commit SHA before enabling
# (mutable tags were the vector in the 2026 trivy-action compromise, CVE-2026-33634).
name: star-config
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      CI: "true"
    steps:
      - uses: actions/checkout@v5 # TODO pin to SHA
        with:
          fetch-depth: 0 # gitleaks scans full history
          persist-credentials: false
      - uses: jdx/mise-action@v3 # TODO pin to SHA — installs mise.toml tools (checksums from mise.lock)
${nodeSteps}      - run: .star/run setup --no-scaffold
      - run: .star/run check --coverage
${e2e}`;
}

/** @param {Ctx} ctx */
export function sonarProperties(ctx) {
  const sources = [
    ctx.stacks.node && 'src',
    ctx.stacks.python && '.',
    ctx.stacks.rust && 'src',
  ].filter(Boolean);
  return `# Managed by star-config. Used by \`star-config sonar scan\` (local SonarQube in Docker).
sonar.projectKey=${ctx.repoName.replaceAll(/[^A-Za-z0-9_.:-]/g, '-')}
sonar.projectName=${ctx.repoName}
sonar.sources=${[...new Set(sources.length ? sources : ['.'])].join(',')}
sonar.exclusions=**/node_modules/**,**/.venv/**,**/target/**,**/dist/**,**/build/**,**/coverage/**
sonar.tests=.
sonar.test.inclusions=**/*.test.*,**/*.spec.*,**/test_*.py,**/tests/**,**/*.bats
${ctx.stacks.node ? 'sonar.javascript.lcov.reportPaths=coverage/lcov.info\n' : ''}${ctx.stacks.python ? 'sonar.python.coverage.reportPaths=coverage.xml\n' : ''}`;
}
