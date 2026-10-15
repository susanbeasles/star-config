# star-config

One command gives any repo lint, format, tests, build, security scanning, git hooks, agent
instructions and a dev container. It detects every stack in the repo, so each team stops
maintaining its own copy of the same tooling.

```sh
curl -fsSL https://install.susanb.dev | sh   # any repo, no Node needed
npm i -D star-config                         # or, in Node repos
star-config setup --owners @your-org/platform
```

## What it sets up

| Stack                 | Format          | Lint                                               | Test                      | Build                        | Security                                           |
| --------------------- | --------------- | -------------------------------------------------- | ------------------------- | ---------------------------- | -------------------------------------------------- |
| JS / TS               | Prettier        | ESLint 10 + typescript-eslint + sonarjs (or Biome) | Vitest · Playwright (web) | esbuild / `npm run build`    | npm audit · cdk-nag (AWS CDK)                      |
| Python                | Ruff            | Ruff (bandit rules)                                | pytest in `.venv`         | `uv build`                   | pip-audit                                          |
| Rust                  | rustfmt         | Clippy `-D warnings`                               | `cargo test`              | `cargo build --release`      | cargo-deny                                         |
| Swift                 | swift-format    | SwiftLint (strict)                                 | `swift test`              | `swift build`                | —                                                  |
| Shell                 | shfmt           | ShellCheck                                         | bats                      | —                            | —                                                  |
| YAML / GitHub Actions | Prettier        | yamllint · actionlint                              | —                         | —                            | —                                                  |
| Docker                | —               | hadolint                                           | —                         | `docker buildx` (`--docker`) | Trivy                                              |
| Terraform             | `terraform fmt` | tflint                                             | —                         | —                            | Checkov · Trivy                                    |
| Cloudflare Workers    | —               | —                                                  | —                         | —                            | wrangler-nag (built in)                            |
| **Every repo**        |                 |                                                    |                           |                              | **Gitleaks · Trivy · Semgrep · SonarQube (local)** |

`setup` also writes these, each only if the repo needs it and doesn't already have it:

- **Governance:** `SECURITY.md`, `.github/CODEOWNERS`, PR template, `.github/dependabot.yml`
  (every detected ecosystem, 7-day cooldown).
- **AI agents:** `AGENTS.md` is the single source; `CLAUDE.md` imports it. Also
  `.github/copilot-instructions.md`, `.claude/settings.json` (denies reading secrets, and a hook
  that formats and lints every file the agent edits) and `.codex/config.toml` (sandboxed, no
  network). Codex reads `AGENTS.md` directly, so there's no `CODEX.md`.
- **Dev environment:** `.devcontainer/` for Codespaces, `.vscode/` (format-on-save with the
  right formatter for each language), `mise.toml` (pinned native tools) and `.editorconfig`.
- **CI:** `.github/workflows/star-config.yml`, which runs `star-config check`.
- **Hooks:** `pre-commit` runs Gitleaks on the staged diff, then lint-staged to format and lint
  staged files. `pre-push` runs lint and unit tests. Hooks work through Husky in Node repos and
  plain `core.hooksPath` everywhere else.

## Commands

```text
setup     detect → write files → install deps (.venv, npm, mise tools) → hooks
sync      re-render managed files after upgrading star-config (keeps files you edited)
doctor    detected stacks, installed/missing tools, pin drift
lint      all linters + format checks (read-only; --fix writes)
format    formatters only
test      every detected test suite (--e2e for Playwright, --coverage)
build     every detected build (--docker for images)
audit     secrets, dependency CVEs, SAST, IaC
check     lint + test + audit — what CI runs
sonar     up | scan | status | down — local SonarQube in Docker
```

Tools that are missing print a warning with an install hint and are skipped on a laptop. When
`CI=true` (or `STAR_CONFIG_STRICT=1`), a missing tool fails the run.

## How it stays current ("rolling", but reviewed)

1. Every version star-config uses is pinned in [`src/tools.js`](src/tools.js) and `package.json`.
2. In this repo, Renovate bumps the native-tool pins and Dependabot bumps npm packages and
   Actions, both after a 7-day cooldown. CI must pass before merge. Tagging a release builds the
   binaries.
3. In consumer repos, Dependabot bumps `star-config`. Then `star-config sync` rewrites
   `mise.toml`, configs and agent files, and `sync --check` in CI flags drift. Files you edited
   are never overwritten. They're tracked by hash in `.star/manifest.json`.

Nothing installs "latest" at runtime. Every machine and CI run uses the same reviewed versions.

## Install and supply-chain controls

- `install.sh` downloads the binary for your OS/arch from GitHub Releases and verifies its
  SHA-256 against `SHA256SUMS`. If the GitHub CLI is logged in, it also verifies the
  build-provenance attestation. Any mismatch stops the install. `STAR_CONFIG_BASE_URL` points it
  at an internal mirror; only https is accepted.
- npm releases are published with `--provenance`.
- `mise.lock` records URLs and checksums for each platform's native tools.
- Release and CI workflows say "pin to SHA". Do that before enabling them. Mutable action tags
  were the attack vector in the 2026 trivy-action compromise (CVE-2026-33634), and star-config
  will never pin trivy 0.69.4.
- Semgrep runs with telemetry and version checks off. Checkov runs with `--skip-download`.
  SonarQube binds to `127.0.0.1` only, and its DB password lives in `~/.config/star-config`
  with mode 0600.

## Configuration

`.star/config.json` (committed):

```json
{
  "owners": ["@your-org/platform"],
  "securityContact": "security@example.com",
  "jsProfile": "eslint",
  "skip": [".github/workflows/star-config.yml"]
}
```

Linter configs extend the shipped presets, so local overrides go in the repo file:

```js
// eslint.config.mjs
import { starConfig } from 'star-config/eslint';
export default [...starConfig({ typeChecked: true }), { rules: { 'sonarjs/todo-tag': 'off' } }];
```

### AWS CDK (cdk-nag)

`setup` installs `cdk-nag`. Add it to your app entry once:

```ts
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks, HIPAASecurityChecks } from 'cdk-nag';
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
Aspects.of(app).add(new HIPAASecurityChecks({ verbose: true }));
```

### Terraform

`terraform fmt` and tflint run on lint. Checkov and Trivy run on audit. Open-source Checkov has
no HIPAA filter. For HIPAA-mapped infrastructure checks, define infrastructure in CDK
(cdk-nag `HIPAASecurityChecks`) or map Checkov IDs in your SSP.

### Cloudflare Workers (wrangler-nag)

There's no upstream cdk-nag equivalent, so star-config ships one:

| Rule  | Level | Check                                                                   |
| ----- | ----- | ----------------------------------------------------------------------- |
| WR001 | error | `compatibility_date` missing                                            |
| WR002 | error | secret-looking value in `vars` (use `wrangler secret put`)              |
| WR003 | error | routes configured but `workers_dev` isn't `false` (bypasses WAF/Access) |
| WR004 | warn  | `observability.enabled` isn't `true`                                    |
| WR005 | warn  | `preview_urls` isn't `false` on a routed Worker                         |
| WR007 | warn  | deprecated `node_compat`                                                |
| WR008 | warn  | `compatibility_date` older than a year                                  |

Every rule runs on the top level and on each `env.*` block.

### SonarQube

SonarLint only runs inside the editor. For the same rules from the CLI, run a local server:

```sh
star-config sonar up          # SonarQube Community + Postgres on 127.0.0.1:9000
export SONAR_TOKEN=…          # from My Account → Security (never committed)
star-config sonar scan
```

Point the IDE extension at `http://127.0.0.1:9000` (Connected Mode) to get the same rules while
you type.

## Known limits

- **TypeScript is pinned to 6.0.x for linting.** typescript-eslint and sonarjs don't support
  TS 7 yet.
- **React Native:** Vitest covers logic and hooks only. Mobile end-to-end tests need Maestro or
  Detox.
- **Swift:** Xcode-project builds and tests (`xcodebuild`) aren't automated yet; only SwiftPM is.
- **Gaps in automated testing:** the pinned versions of Gitleaks, Trivy, SwiftLint,
  swift-format, tflint and terraform were never run by the automated tests. Run
  `star-config doctor` on a real machine to confirm them.

## Develop

Requires Node 24 (`.nvmrc`). The release binaries are built with Node 24 too.

```sh
npm test                 # unit + e2e against real tools (missing tools are skipped)
npm run typecheck
node bin/star-config.js check
npm run build:sea        # single-file binary for this platform → dist/
```
