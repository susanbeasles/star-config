# star-config

Shared formatting, lint, test, build, and audit tooling for JavaScript/TypeScript,
Python, Rust, Swift, Shell, Docker, YAML, Terraform, and Cloudflare projects.

The public package name is `@susanbeasles/star-config`. It is not yet registered
on npm; installation from the public registry is blocked until the initial
registration and trusted publisher configuration are complete.

## Project setup

Install with `yarn add --dev @susanbeasles/star-config` or the equivalent npm,
pnpm, or Bun command once the package is published. The lifecycle initializer
preserves existing configurations and scripts and only acts on a project that
already declares this package as a direct dependency.

npm saves a newly added dependency after its lifecycle scripts run. For that
first addition, run `star-config init` through your package manager after
installation. Scripts-disabled installs also require explicit initialization.
The Yarn first-add path has not been qualified. Unattended first-add setup across
all package managers is **not currently guaranteed**.

`init` adds tooling configuration and missing package scripts. It does not run
project commands, install native toolchains, provision a host runner, modify Git
hook policy, or install agent execution hooks. Existing host security boundaries
remain enforced by `setup` and `hooks`. Managed writes currently require Linux;
macOS and Windows initialization remain unsupported. Automatic postinstall setup
is skipped on those platforms so dependency installation can succeed.

## Commands

- `star-config lint` / `lint --fix`
- `star-config format`
- `star-config test` / `test --coverage` / `test --e2e`
- `star-config build`
- `star-config audit`
- `star-config check` (lint, tests, build, audit)
- `star-config doctor`
- `star-config sync`

Node tooling ships as dependencies. Native toolchains are pinned in generated
`mise.toml`; installing them remains a separate, explicit provisioning operation.
Missing tools fail in CI or with `STAR_CONFIG_STRICT=1` and warn locally.
The shared Vitest coverage configuration enforces 100% thresholds; existing
project configurations are preserved. This repository's measured coverage is
lower, and some host/tool-dependent qualification tests are conditional.

## Releases

`.github/workflows/release.yml` verifies the exact source commit, derives its
version from conventional commit messages, and builds minified npm artifacts
plus standalone executables. Breaking changes bump major, `feat` bumps minor,
and other changes bump patch. Source versions are stamped into artifacts without
adding release commits to `main`. Existing version tags establish subsequent
release versions.

Publishing uses GitHub Actions OIDC and npm provenance, without an npm token or
manual approval environment. npm must trust owner `susanbeasles`, repository
`star-config`, workflow `release.yml`, with no environment binding. Initial
registration requires authenticated npm account access. The workflow publishes
npm before creating the GitHub Release and checks artifact integrity on retries.
Existing release assets are never overwritten with different bytes.

Dependency updates retain their existing conservative merge policy. Protected
branches currently require manual integration; this change does not bypass
repository rules or provision external account permissions.

## Package validation

`npm run build` writes a staging package to `build/package`. `npm run test:package`
installs its tarball in a synthetic project and checks initialization, preserved
edits, package exports, test execution, build execution, and size/content budgets.
Only minified modules, runtime configs, package metadata, and the license ship.
Root README files, tests, source maps, and build scripts do not ship. The requested
repository instruction templates ship as explicit baseline assets.
Tool dependencies contribute additional installation size beyond the small
star-config tarball.

The standalone installer defaults to `/usr/local/bin` and checks write access
before downloading. For a privileged install, save and review `install.sh`, then
run `sudo sh install.sh`. It never elevates automatically.

## Shared repository baseline

`init` and `sync` install the account-wide baseline: `AGENTS.md`, `INSTRUCTIONS.md`,
`CLAUDE.md`, `GEMINI.md`, `CODEX.md`, `.github/copilot-instructions.md`,
`.github/dependabot.yml`, `.github/codeql/codeql-config.yml`, and `.gitignore`.
Canonical static files live under `configs/repository/`; Dependabot uses the
shared policy with detected dependency ecosystems. All agent adapters point to
root `AGENTS.md`; they do not define separate policies or install execution hooks.

Missing files are created; unchanged managed files receive template updates.
Locally edited or previously unmanaged files are preserved and reported, so a
shared update cannot silently replace project-specific instructions or ignore
rules. `sync` reports preserved conflicts; `sync --check` also exits nonzero when
managed files need to be written or updated.
Use `sync --force` only when intentionally replacing local files. Explicit
`star-config init` also works in non-Node repositories without creating a
`package.json`; install-time hooks remain limited to declared direct consumers.

The CodeQL configuration adds `security-extended` while retaining default
queries. A configuration file alone does not enable code scanning: an existing
CodeQL workflow must use its `config-file` input, or supported GitHub default
setup must reference it through the repository property. No GitHub account
settings or other repositories are changed by installing this package here.
