// star-config — ESLint 10 flat config.
// Prettier owns formatting; ESLint owns correctness, style-guide and security rules.
//
// Repo usage (eslint.config.mjs):
//   import { starConfig } from '@susanbeasles/star-config/eslint';
//   export default starConfig();                         // auto-detects React / RN / tests
//   export default starConfig({ typeChecked: true });    // + type-aware rules (slower; good for CI)
//   export default [...starConfig(), { rules: { ... } }]; // local overrides last
import { readFileSync } from 'node:fs';
import path from 'node:path';
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import react from '@eslint-react/eslint-plugin';
import vitest from '@vitest/eslint-plugin';
import prettier from 'eslint-config-prettier';
import playwright from 'eslint-plugin-playwright';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const TS = ['**/*.{ts,tsx,mts,cts}'];
const JSX = ['**/*.{jsx,tsx}'];
const UNIT_TESTS = ['**/*.{test,spec}.{js,mjs,cjs,jsx,ts,mts,cts,tsx}', '**/__tests__/**'];
const E2E = ['e2e/**', '**/*.e2e.{js,ts}', 'tests/e2e/**', 'playwright/**'];

function readDeps(cwd) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  } catch {
    return {};
  }
}

/**
 * @param {{
 *   cwd?: string,
 *   react?: boolean,
 *   typeChecked?: boolean,
 *   ignores?: string[],
 * }} [options]
 */
export function starConfig(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const deps = readDeps(cwd);
  const useReact = options.react ?? Boolean(deps.react);
  const reactNative = Boolean(deps['react-native'] || deps.expo);

  return defineConfig(
    {
      ignores: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        '**/.next/**',
        '**/cdk.out/**',
        '**/.venv/**',
        '**/target/**',
        '**/*.min.js',
        'playwright-report/**',
        'test-results/**',
        ...(options.ignores ?? []),
      ],
    },
    js.configs.recommended,
    sonarjs.configs.recommended,
    {
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        globals: { ...globals.node, ...(useReact && !reactNative ? globals.browser : {}) },
      },
      linterOptions: { reportUnusedDisableDirectives: 'error' },
      rules: {
        // Healthcare: stray console.log is a common PHI leak path into logs.
        'no-console': ['error', { allow: ['warn', 'error'] }],
        'no-eval': 'error',
        'no-implied-eval': 'error',
        'no-new-func': 'error',
        eqeqeq: ['error', 'always'],
        curly: ['error', 'all'],
        'prefer-const': 'error',
        'no-var': 'error',
        'no-param-reassign': 'error',
        'object-shorthand': 'error',
        'prefer-template': 'error',
        'sonarjs/cognitive-complexity': ['error', 15],
        'sonarjs/no-hardcoded-passwords': 'error',
        'sonarjs/no-hardcoded-secrets': 'error',
        'sonarjs/todo-tag': 'warn',
        'no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            destructuredArrayIgnorePattern: '^_',
          },
        ],
        'sonarjs/no-unused-vars': 'off', // core rule above is configurable and covers it
      },
    },
    {
      files: TS,
      extends: options.typeChecked
        ? [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked]
        : [...tseslint.configs.strict, ...tseslint.configs.stylistic],
      languageOptions: options.typeChecked
        ? { parserOptions: { projectService: true, tsconfigRootDir: cwd } }
        : {},
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-non-null-assertion': 'error',
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
      },
    },
    ...(useReact
      ? [
          {
            files: JSX,
            ...react.configs[
              options.typeChecked ? 'recommended-type-checked' : 'recommended-typescript'
            ],
          },
          {
            files: JSX,
            plugins: { 'react-hooks': reactHooks },
            rules: reactHooks.configs.recommended.rules,
          },
        ]
      : []),
    {
      files: UNIT_TESTS,
      plugins: { vitest },
      rules: {
        ...vitest.configs.recommended.rules,
        'vitest/valid-expect': ['error', { maxArgs: 2 }], // expect(value, message) is valid Vitest
        'no-console': 'off',
        'sonarjs/no-hardcoded-passwords': 'off', // fixtures; gitleaks still scans for real secrets
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
      languageOptions: { globals: vitest.environments.env.globals },
    },
    {
      files: E2E,
      ...playwright.configs['flat/recommended'],
    },
    {
      files: ['**/bin/**', '**/scripts/**', '**/cli/**', '*.config.{js,mjs,cjs,ts}'],
      rules: { 'no-console': 'off' },
    },
    {
      files: ['**/*.{js,cjs,mjs}'],
      extends: [tseslint.configs.disableTypeChecked],
    },
    // Turns off every rule that would fight Prettier...
    prettier,
    // ...then re-enable `curly`, which is safe with Prettier when set to "all".
    { rules: { curly: ['error', 'all'] } },
  );
}

export default starConfig();
