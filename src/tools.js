// @ts-check
/**
 * Every version star-config pins, in one place. Renovate's regex manager bumps these
 * (see renovate.json): each line carries a `renovate:` comment with its datasource.
 * Consumers get new versions by upgrading star-config and running `star-config sync`.
 */

/** Native CLIs installed with mise (https://mise.jdx.dev). Keys are mise registry short names. */
export const MISE_TOOLS = /** @type {const} */ ({
  // renovate: datasource=github-releases depName=gitleaks/gitleaks
  gitleaks: '8.30.1',
  // renovate: datasource=github-releases depName=aquasecurity/trivy
  // NOTE: 0.69.4 was a malicious release (CVE-2026-33634). Never pin it.
  trivy: '0.76.0',
  // renovate: datasource=pypi depName=semgrep
  semgrep: '1.180.0',
  // renovate: datasource=github-releases depName=rhysd/actionlint
  actionlint: '1.7.12',
  // renovate: datasource=github-releases depName=hadolint/hadolint
  hadolint: '2.15.1',
  // renovate: datasource=github-releases depName=koalaman/shellcheck
  shellcheck: '0.11.0',
  // renovate: datasource=github-releases depName=mvdan/sh
  shfmt: '3.14.1',
  // renovate: datasource=github-releases depName=bats-core/bats-core
  bats: '1.13.0',
  // renovate: datasource=pypi depName=yamllint
  yamllint: '1.38.0',
  // renovate: datasource=github-releases depName=astral-sh/uv
  uv: '0.13.1',
  // renovate: datasource=pypi depName=poetry
  poetry: '2.5.1',
  // renovate: datasource=pypi depName=ruff
  ruff: '0.17.0',
  // renovate: datasource=github-releases depName=EmbarkStudios/cargo-deny
  'cargo-deny': '0.20.2',
  // renovate: datasource=github-releases depName=terraform-linters/tflint
  tflint: '0.64.0',
  // renovate: datasource=pypi depName=checkov
  checkov: '3.3.29',
  // renovate: datasource=github-releases depName=realm/SwiftLint
  swiftlint: '0.63.3',
});

/** npm devDependencies `setup` adds to Node repos (exact versions). */
export const NPM_DEV = /** @type {const} */ ({
  // typescript-eslint and eslint-plugin-sonarjs support TypeScript < 6.1 (no TS 7 yet).
  // renovate: datasource=npm depName=typescript
  typescript: '6.0.3',
  // renovate: datasource=npm depName=vitest
  vitest: '5.0.5',
  // renovate: datasource=npm depName=@vitest/coverage-v8
  '@vitest/coverage-v8': '5.0.5',
  // renovate: datasource=npm depName=@playwright/test
  '@playwright/test': '1.64.1',
  // renovate: datasource=npm depName=esbuild
  esbuild: '0.28.2',
  // renovate: datasource=npm depName=cdk-nag
  'cdk-nag': '3.0.2',
});

/** Python dev dependencies `setup` adds to the uv-managed venv. */
export const PY_DEV = /** @type {const} */ ({
  // renovate: datasource=pypi depName=ruff
  ruff: '0.17.0',
  // renovate: datasource=pypi depName=pytest
  pytest: '9.1.1',
  // renovate: datasource=pypi depName=pytest-cov
  'pytest-cov': '7.1.0',
  // renovate: datasource=pypi depName=pip-audit
  'pip-audit': '2.10.1',
  // renovate: datasource=pypi depName=mypy
  mypy: '2.4.0',
});
