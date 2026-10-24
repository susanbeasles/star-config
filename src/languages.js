// @ts-check
/**
 * Per-file lint/format steps. lint-staged globs, `run`, `lint` and `format` are all
 * derived from this table. Steps for one language run sequentially (formatter first,
 * then linter) so two writers never touch the same file concurrently.
 *
 * @typedef {'fix' | 'check'} Mode
 *
 * @typedef {object} ConfigSpec
 * @property {string} [asset]                Shipped default (path under the package), injected when the repo has none.
 * @property {string[]} local                Repo-local names that win when present. `file#table` = TOML file containing [table].
 * @property {(path: string) => string[]} [flag]
 *
 * @typedef {object} Step
 * @property {string} tool                   Display name and PATH binary.
 * @property {{ pkg: string, bin?: string }} [npm]  Resolve from node_modules first.
 * @property {boolean} [venv]                Prefer .venv/bin/<tool> (Python tools).
 * @property {string[][]} [fallbacks]        Pinned launchers when not installed.
 * @property {Partial<Record<Mode, string[] | null>>} args   null = step does not run in that mode.
 * @property {ConfigSpec} [config]
 * @property {(file: string) => boolean} [filter]  Subset of the language's files this step takes.
 * @property {string} install                Human install hint.
 * @property {boolean} [format]             Formatter step (used by `star-config format`).
 * @property {boolean} [perFile]            Tool accepts one file per invocation.
 *
 * @typedef {object} Language
 * @property {string} id
 * @property {string} label
 * @property {string[]} extensions           Lowercase, no dot.
 * @property {RegExp} [basename]             Extra basename matcher (Dockerfile, etc.).
 * @property {string} glob                   lint-staged glob.
 * @property {Step[]} steps
 */
import { NPM_NAME } from './constants.js';
import { DOCKERFILE_RE } from './detect.js';
import { MISE_TOOLS } from './tools.js';

const MISE_HINT = (/** @type {string} */ tool) =>
  `star-config setup  (installs ${tool} via mise)  |  mise use ${tool}`;

/** @type {Step} */
const PRETTIER = {
  tool: 'prettier',
  format: true,
  npm: { pkg: 'prettier' },
  args: {
    fix: ['--write', '--ignore-unknown', '--log-level=warn'],
    check: ['--check', '--ignore-unknown', '--log-level=warn'],
  },
  config: {
    asset: 'configs/prettier.config.mjs',
    local: [
      'prettier.config.js',
      'prettier.config.mjs',
      'prettier.config.cjs',
      '.prettierrc',
      '.prettierrc.json',
      '.prettierrc.yaml',
      '.prettierrc.yml',
      '.prettierrc.js',
      '.prettierrc.mjs',
      'package.json#prettier',
    ],
    flag: (p) => ['--config', p],
  },
  install: `npm i -D ${NPM_NAME}`,
};

/** @type {Step} */
const ESLINT = {
  tool: 'eslint',
  npm: { pkg: 'eslint' },
  args: {
    fix: ['--fix', '--max-warnings=0', '--no-warn-ignored'],
    check: ['--max-warnings=0', '--no-warn-ignored'],
  },
  config: {
    asset: 'configs/eslint.config.mjs',
    local: [
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
      'eslint.config.mts',
    ],
    flag: (p) => ['--config', p],
  },
  install: `npm i -D ${NPM_NAME}`,
};

/** @type {Step} */
const BIOME = {
  tool: 'biome',
  format: true,
  npm: { pkg: '@biomejs/biome', bin: 'biome' },
  args: {
    fix: ['check', '--write', '--no-errors-on-unmatched', '--files-ignore-unknown=true'],
    check: ['ci', '--no-errors-on-unmatched', '--files-ignore-unknown=true'],
  },
  install: `npm i -D ${NPM_NAME}`,
};

const JS_EXT = ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx'];
const DATA_EXT = [
  'json',
  'jsonc',
  'json5',
  'css',
  'scss',
  'less',
  'html',
  'vue',
  'md',
  'mdx',
  'graphql',
  'gql',
];
const BIOME_EXT = ['json', 'jsonc', 'css', 'graphql', 'gql'];

const globOf = (/** @type {string[]} */ e) => (e.length === 1 ? `*.${e[0]}` : `*.{${e.join(',')}}`);

/** @param {'eslint' | 'biome'} profile */
function jsLanguages(profile) {
  if (profile === 'biome') {
    const docs = DATA_EXT.filter((e) => !BIOME_EXT.includes(e));
    return [
      {
        id: 'js',
        label: 'JS / TS / JSON / CSS (Biome)',
        extensions: [...JS_EXT, ...BIOME_EXT],
        glob: globOf([...JS_EXT, ...BIOME_EXT]),
        steps: [BIOME],
      },
      {
        id: 'docs',
        label: 'Markdown / HTML / SCSS (Prettier)',
        extensions: docs,
        glob: globOf(docs),
        steps: [PRETTIER],
      },
    ];
  }
  return [
    {
      id: 'js',
      label: 'JS / TS (Prettier + ESLint)',
      extensions: JS_EXT,
      glob: globOf(JS_EXT),
      steps: [PRETTIER, ESLINT],
    },
    {
      id: 'docs',
      label: 'JSON / CSS / Markdown / HTML (Prettier)',
      extensions: DATA_EXT,
      glob: globOf(DATA_EXT),
      steps: [PRETTIER],
    },
  ];
}

const RUFF_CONFIG = {
  asset: 'configs/ruff.toml',
  local: ['ruff.toml', '.ruff.toml', 'pyproject.toml#tool.ruff'],
  flag: (/** @type {string} */ p) => ['--config', p],
};
const RUFF_FALLBACKS = [
  ['uvx', `ruff@${MISE_TOOLS.ruff}`],
  ['pipx', 'run', `ruff==${MISE_TOOLS.ruff}`],
];

/** @type {Language[]} */
const NATIVE = [
  {
    id: 'python',
    label: 'Python (Ruff)',
    extensions: ['py', 'pyi'],
    glob: '*.{py,pyi}',
    steps: [
      {
        tool: 'ruff',
        format: true,
        venv: true,
        fallbacks: RUFF_FALLBACKS,
        args: {
          fix: ['format', '--force-exclude'],
          check: ['format', '--check', '--force-exclude'],
        },
        config: RUFF_CONFIG,
        install: MISE_HINT('ruff'),
      },
      {
        tool: 'ruff',
        venv: true,
        fallbacks: RUFF_FALLBACKS,
        args: { fix: ['check', '--fix', '--force-exclude'], check: ['check', '--force-exclude'] },
        config: RUFF_CONFIG,
        install: MISE_HINT('ruff'),
      },
    ],
  },
  {
    id: 'yaml',
    label: 'YAML (Prettier + yamllint + actionlint)',
    extensions: ['yml', 'yaml'],
    glob: '*.{yml,yaml}',
    steps: [
      PRETTIER,
      {
        tool: 'yamllint',
        venv: true,
        fallbacks: [
          ['uvx', `yamllint@${MISE_TOOLS.yamllint}`],
          ['pipx', 'run', `yamllint==${MISE_TOOLS.yamllint}`],
        ],
        args: { fix: ['--strict'], check: ['--strict'] },
        config: {
          asset: 'configs/yamllint.yml',
          local: ['.yamllint', '.yamllint.yml', '.yamllint.yaml'],
          flag: (p) => ['-c', p],
        },
        install: MISE_HINT('yamllint'),
      },
      {
        tool: 'actionlint',
        filter: (f) => f.replaceAll('\\', '/').startsWith('.github/workflows/'),
        args: { fix: [], check: [] },
        install: MISE_HINT('actionlint'),
      },
    ],
  },
  {
    id: 'shell',
    label: 'Shell (shfmt + ShellCheck)',
    extensions: ['sh', 'bash', 'bats'],
    glob: '*.{sh,bash,bats}',
    steps: [
      {
        tool: 'shfmt',
        format: true,
        args: { fix: ['--write'], check: ['--diff'] },
        install: MISE_HINT('shfmt'),
      },
      {
        tool: 'shellcheck',
        filter: (f) => !f.endsWith('.bats'),
        args: { fix: ['--external-sources'], check: ['--external-sources'] },
        config: {
          asset: 'configs/shellcheckrc',
          local: ['.shellcheckrc', 'shellcheckrc'],
          flag: (p) => ['--rcfile', p],
        },
        install: MISE_HINT('shellcheck'),
      },
    ],
  },
  {
    id: 'docker',
    label: 'Dockerfile (hadolint)',
    extensions: ['dockerfile', 'containerfile'],
    basename: DOCKERFILE_RE,
    glob: '{Dockerfile,Dockerfile.*,Containerfile,Containerfile.*,*.dockerfile,*.Dockerfile,*.containerfile}',
    steps: [
      {
        tool: 'hadolint',
        args: { fix: [], check: [] },
        config: {
          asset: 'configs/hadolint.yaml',
          local: ['.hadolint.yaml', '.hadolint.yml'],
          flag: (p) => ['--config', p],
        },
        install: MISE_HINT('hadolint'),
      },
    ],
  },
  {
    id: 'swift',
    label: 'Swift (swift-format + SwiftLint)',
    extensions: ['swift'],
    glob: '*.swift',
    steps: [
      {
        tool: 'swift-format',
        format: true,
        fallbacks: [
          ['xcrun', 'swift-format'],
          ['swift', 'format'],
        ],
        args: { fix: ['format', '--in-place'], check: ['lint', '--strict'] },
        config: {
          asset: 'configs/swift-format.json',
          local: ['.swift-format'],
          flag: (p) => ['--configuration', p],
        },
        install: 'Ships with Xcode 16+ / Swift 6 toolchains',
      },
      {
        tool: 'swiftlint',
        args: {
          fix: ['lint', '--fix', '--strict', '--quiet'],
          check: ['lint', '--strict', '--quiet'],
        },
        config: {
          asset: 'configs/swiftlint.yml',
          local: ['.swiftlint.yml'],
          flag: (p) => ['--config', p],
        },
        install: MISE_HINT('swiftlint'),
      },
    ],
  },
  {
    id: 'terraform',
    label: 'Terraform (terraform fmt)',
    extensions: ['tf', 'tfvars'],
    glob: '*.{tf,tfvars}',
    steps: [
      {
        tool: 'terraform',
        format: true,
        perFile: true,
        fallbacks: [['tofu']],
        args: { fix: ['fmt'], check: ['fmt', '-check', '-diff'] },
        install: 'mise use terraform  |  mise use opentofu',
      },
    ],
  },
  {
    id: 'rust',
    label: 'Rust (rustfmt)',
    extensions: ['rs'],
    glob: '*.rs',
    steps: [
      {
        tool: 'rustfmt',
        format: true,
        args: { fix: [], check: ['--check'] },
        config: {
          asset: 'configs/rustfmt.toml',
          local: ['rustfmt.toml', '.rustfmt.toml'],
          flag: (p) => ['--config-path', p],
        },
        install: 'rustup component add rustfmt',
      },
    ],
  },
];

/**
 * @param {{ jsProfile?: 'eslint' | 'biome' }} [opts]
 * @returns {Language[]}
 */
export function getLanguages({ jsProfile = 'eslint' } = {}) {
  return [...jsLanguages(jsProfile), ...NATIVE];
}

/**
 * @param {string} id
 * @param {{ jsProfile?: 'eslint' | 'biome' }} [opts]
 */
export function getLanguage(id, opts) {
  const all = getLanguages(opts);
  const lang = all.find((l) => l.id === id);
  if (!lang) {
    throw new Error(`Unknown language "${id}". Known: ${all.map((l) => l.id).join(', ')}`);
  }
  return lang;
}

/**
 * @param {Language} lang
 * @param {string} file  repo-relative path
 */
export function matches(lang, file) {
  const normalized = file.replaceAll('\\', '/');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (lang.basename?.test(name)) {
    return true;
  }
  const dot = name.lastIndexOf('.');
  return dot > 0 && lang.extensions.includes(name.slice(dot + 1).toLowerCase());
}

/**
 * lint-staged config: one glob per language, delegating to `star-config run <id>`.
 * @param {{ command?: string, jsProfile?: 'eslint' | 'biome' }} [opts]
 * @returns {Record<string, string>}
 */
export function createLintStagedConfig({ command = 'star-config', jsProfile = 'eslint' } = {}) {
  return Object.fromEntries(
    getLanguages({ jsProfile }).map((l) => [l.glob, `${command} run ${l.id}`]),
  );
}
