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
hook policy, or generate agent instructions. Existing host security boundaries
remain enforced by `setup` and `hooks`. Managed writes currently require Linux;
macOS and Windows initialization remain unsupported.

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
README files, agent templates, tests, source maps, and build scripts do not ship.
Tool dependencies contribute additional installation size beyond the small
star-config tarball.
