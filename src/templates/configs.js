// @ts-check
/** Thin repo-side config stubs that extend star-config's shipped configs (editor-visible). */
import { readAsset } from '../assets.js';
import { NPM_NAME } from '../constants.js';

/** @typedef {import('./governance.js').Ctx} Ctx */

const NM = `node_modules/${NPM_NAME}/configs`;

/**
 * Files only make sense extending from node_modules when the package is installed there.
 * Otherwise (binary installs) we copy the shipped config.
 * @param {Ctx} ctx
 * @param {string} asset
 * @param {(base: string) => string} extendStub
 */
const extendOrCopy = (ctx, asset, extendStub) =>
  ctx.stacks.node ? extendStub(`${NM}/${asset}`) : readAsset(`configs/${asset}`);

/**
 * @param {Ctx} ctx
 * @returns {Record<string, string>}  repo-relative path → content
 */
export function lintConfigFiles(ctx) {
  const s = ctx.stacks;
  /** @type {Record<string, string>} */
  const out = { '.editorconfig': readAsset('configs/editorconfig') };
  if (s.node) {
    if (s.node.lintProfile === 'biome') {
      out['biome.json'] = `{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "root": true,
  "extends": ["${NPM_NAME}/biome"]
}
`;
    } else {
      out['eslint.config.mjs'] = `import { starConfig } from '${NPM_NAME}/eslint';

export default [
  ...starConfig(),
  // Local overrides go here, e.g. { files: ['scripts/**'], rules: { 'no-console': 'off' } },
];
`;
    }
    out['prettier.config.mjs'] = `export { default } from '${NPM_NAME}/prettier';\n`;
    out['.prettierignore'] = readAsset('configs/prettierignore');
    out['lint-staged.config.mjs'] =
      `import { createLintStagedConfig } from '${NPM_NAME}/lint-staged';

export default createLintStagedConfig({ command: '.star/run', jsProfile: '${s.node.lintProfile}' });
`;
  }
  if (s.python) {
    out['ruff.toml'] = extendOrCopy(ctx, 'ruff.toml', (p) => `extend = "${p}"\n`);
  }
  if (s.yaml || s.githubActions) {
    out['.yamllint.yml'] = extendOrCopy(ctx, 'yamllint.yml', (p) => `extends: ${p}\n`);
  }
  if (s.shell) {
    out['.shellcheckrc'] = readAsset('configs/shellcheckrc');
  }
  if (s.docker) {
    out['.hadolint.yaml'] = readAsset('configs/hadolint.yaml');
  }
  if (s.swift) {
    out['.swiftlint.yml'] = extendOrCopy(ctx, 'swiftlint.yml', (p) => `parent_config: ${p}\n`);
    out['.swift-format'] = readAsset('configs/swift-format.json');
  }
  if (s.terraform) {
    out['.tflint.hcl'] = readAsset('configs/tflint.hcl');
  }
  if (s.rust) {
    out['rustfmt.toml'] = readAsset('configs/rustfmt.toml');
    out['clippy.toml'] = readAsset('configs/clippy.toml');
    out['deny.toml'] = readAsset('configs/deny.toml');
  }
  return out;
}

/**
 * Test-runner configs, only when the repo has none.
 * @param {Ctx} ctx
 * @returns {Record<string, string>}
 */
export function testConfigFiles(ctx) {
  const s = ctx.stacks;
  /** @type {Record<string, string>} */
  const out = {};
  const has = (/** @type {RegExp} */ re) => ctx.files.some((f) => re.test(f));
  if (s.node && !s.node.reactNative && !has(/^vitest\.config\./) && !has(/^vite\.config\./)) {
    out[s.node.typescript ? 'vitest.config.ts' : 'vitest.config.mjs'] =
      `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: ['**/node_modules/**', 'e2e/**', 'dist/**'],
    coverage: { provider: 'v8', reporter: ['text', 'lcov'], include: ['src/**'] },
  },
});
`;
  }
  if (s.node?.web && !has(/^playwright\.config\./)) {
    out['playwright.config.ts'] = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
    // Screenshots/videos can capture PHI from real environments: keep them for synthetic data only.
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`;
  }
  return out;
}
