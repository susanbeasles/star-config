// @ts-check
import { parse } from 'smol-toml';
import { readManaged } from './managed-files.js';

/** @type {Array<[string, string[], string | null]>} */
const GROUPS = [
  [
    'eslint.config.mjs',
    [
      'eslint.config.js',
      'eslint.config.cjs',
      'eslint.config.ts',
      'eslint.config.mts',
      'eslint.config.cts',
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.cjs',
      '.eslintrc.json',
      '.eslintrc.yml',
      '.eslintrc.yaml',
    ],
    'eslintConfig',
  ],
  [
    'prettier.config.mjs',
    [
      'prettier.config.js',
      'prettier.config.cjs',
      'prettier.config.ts',
      'prettier.config.mts',
      'prettier.config.cts',
      '.prettierrc',
      '.prettierrc.json',
      '.prettierrc.js',
      '.prettierrc.cjs',
      '.prettierrc.mjs',
      '.prettierrc.ts',
      '.prettierrc.yml',
      '.prettierrc.yaml',
      '.prettierrc.toml',
    ],
    'prettier',
  ],
  ['biome.json', ['biome.jsonc'], null],
  ['ruff.toml', ['.ruff.toml'], null],
  ['rustfmt.toml', ['.rustfmt.toml'], null],
  ['clippy.toml', ['.clippy.toml'], null],
  ['.swiftlint.yml', ['.swiftlint.yaml'], null],
  [
    'lint-staged.config.mjs',
    [
      'lint-staged.config.js',
      'lint-staged.config.cjs',
      '.lintstagedrc',
      '.lintstagedrc.json',
      '.lintstagedrc.yml',
      '.lintstagedrc.yaml',
      '.lintstagedrc.js',
      '.lintstagedrc.cjs',
    ],
    'lint-staged',
  ],
];

/** Preserve alternate or embedded configurations instead of introducing a competing file.
 * @param {string} root @param {Record<string, {content: string, mode?: number}>} files
 * @param {Record<string, unknown> | null} pkg
 */
export function preserveConfiguredTools(root, files, pkg) {
  const result = { ...files };
  for (const [destination, aliases, field] of GROUPS) {
    const target = /** @type {string} */ (destination);
    const alternatives = /** @type {string[]} */ (aliases);
    if (
      alternatives.some((file) => readManaged(root, file) !== null) ||
      (typeof field === 'string' && pkg && Object.hasOwn(pkg, field))
    ) {
      delete result[target];
    }
  }
  const pyproject = readManaged(root, 'pyproject.toml');
  if (pyproject !== null) {
    try {
      const config = parse(pyproject);
      if (/** @type {{tool?: {ruff?: unknown}}} */ (config).tool?.ruff) {
        delete result['ruff.toml'];
      }
    } catch {
      // An unrecognized project configuration is preserved, never repaired during installation.
      delete result['ruff.toml'];
    }
  }
  return result;
}

const NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.toml',
  'Cargo.lock',
  'pyproject.toml',
  'uv.lock',
  'poetry.lock',
  'requirements.txt',
  'Package.swift',
  'Package.resolved',
  '.gitignore',
  '.editorconfig',
  '.prettierignore',
  '.swift-format',
  '.swiftlint.yml',
  '.swiftlint.yaml',
  'rustfmt.toml',
  '.rustfmt.toml',
  'clippy.toml',
  '.clippy.toml',
  'ruff.toml',
  '.ruff.toml',
  'biome.json',
  'biome.jsonc',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.ts',
  'vitest.config.mts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'pytest.ini',
  'tox.ini',
  'setup.cfg',
  ...GROUPS.flatMap(([destination, aliases]) => [
    destination,
    .../** @type {string[]} */ (aliases),
  ]),
]);

/** @param {string} file */
export function configurationFile(file) {
  return NAMES.has(file.split('/').at(-1) ?? '');
}
