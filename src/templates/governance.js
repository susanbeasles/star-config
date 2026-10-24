// @ts-check
import { NPM_NAME } from '../constants.js';
/**
 * @typedef {import('../detect.js').Stacks} Stacks
 * @typedef {{ stacks: Stacks, repoName: string, owners: string[], securityContact: string | null, version: string, files: string[], skip?: string[] }} Ctx
 */

/** @param {Ctx} ctx */
export function securityMd(ctx) {
  const contact = ctx.securityContact
    ? `Email **${ctx.securityContact}**`
    : "Use GitHub's **private vulnerability reporting** (Security → Report a vulnerability)";
  return `# Security Policy

## Reporting a vulnerability

${contact}. Please do **not** open a public issue, PR, or discussion.

Include:

- affected component and version/commit
- reproduction steps or proof of concept
- impact as you understand it

**Never include PHI, PII, credentials, or production data** in a report. Use synthetic
data. If you believe PHI was exposed, say so in the first line so we can start our incident
process immediately.

We acknowledge reports within 2 business days and share a remediation plan within 10.

## Supported versions

Only the latest release on the default branch receives security fixes.

## How this repository is protected

| Control | Tool | Where |
|---|---|---|
| Secret scanning | Gitleaks (redacted output) | pre-commit, CI |
| Dependency vulnerabilities | Trivy${ctx.stacks.node ? ', npm audit' : ''}${ctx.stacks.python ? ', pip-audit' : ''}${ctx.stacks.rust ? ', cargo-deny' : ''} | CI, Dependabot |
| Static analysis (SAST) | Semgrep, ${ctx.stacks.node ? 'eslint-plugin-sonarjs, ' : ''}SonarQube | CI, IDE |
| IaC misconfiguration | Trivy${ctx.stacks.node?.cdk ? ', cdk-nag (HIPAA + AWS Solutions packs)' : ''}${ctx.stacks.terraform ? ', Checkov' : ''}${ctx.stacks.cloudflare ? ', wrangler-nag' : ''} | CI |
| Dependency updates | Dependabot with a 7-day cooldown | weekly |

Tooling is managed by [star-config](https://www.npmjs.com/package/${NPM_NAME}) v${ctx.version}.
`;
}

/** @param {Ctx} ctx */
export function codeowners(ctx) {
  const owners = ctx.owners.length ? ctx.owners.join(' ') : null;
  const line = owners
    ? `* ${owners}`
    : '# * @your-org/your-team   ← set with `star-config setup --owners @org/team`';
  return `# Managed by star-config. Every PR needs a review from an owner below.
# Docs: https://docs.github.com/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners
${line}

# Security-sensitive paths: keep these owned by a team with security review rights.
${owners ? `/.github/ ${owners}\n/SECURITY.md ${owners}\n/.star/ ${owners}` : '# /.github/ @your-org/security'}
`;
}

/** @param {Ctx} ctx */
export function prTemplate(ctx) {
  return `## What & why

<!-- One or two sentences. Link the ticket. -->

## How it was tested

- [ ] \`star-config check\` passes locally${ctx.stacks.node?.web ? '\n- [ ] E2E (`star-config test --e2e`) passes for affected flows' : ''}
- [ ] New/changed behavior has tests

## Security & privacy

- [ ] No PHI/PII in code, tests, fixtures, logs, screenshots, or this description
- [ ] No secrets added (Gitleaks clean); new secrets go through the secrets manager
- [ ] Access to data follows minimum-necessary; new endpoints are authenticated and authorized
- [ ] Audit logging is preserved for any data access paths touched
- [ ] Infra changes reviewed against IaC findings (Trivy${ctx.stacks.node?.cdk ? ' / cdk-nag' : ''}${ctx.stacks.terraform ? ' / Checkov' : ''}${ctx.stacks.cloudflare ? ' / wrangler-nag' : ''})

## AI assistance

- [ ] An AI agent helped write this change (disclose which; a human reviewed every line)
`;
}

/**
 * @param {Ctx} ctx
 */
export function dependabotYml(ctx) {
  const { stacks: s, files } = ctx;
  /** @type {Array<{ eco: string, dir: string }>} */
  const updates = [];
  if (s.node) {
    updates.push({ eco: s.node.pm === 'bun' ? 'bun' : 'npm', dir: '/' });
  }
  if (s.python) {
    updates.push({
      eco:
        s.python.manager === 'uv' && (files.includes('uv.lock') || s.python.hasPyproject)
          ? 'uv'
          : 'pip',
      dir: '/',
    });
  }
  if (s.rust) {
    updates.push({ eco: 'cargo', dir: '/' });
  }
  if (s.swift?.spm) {
    updates.push({ eco: 'swift', dir: '/' });
  }
  for (const dir of new Set(
    (s.docker?.files ?? []).map((f) => `/${f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''}`),
  )) {
    updates.push({ eco: 'docker', dir });
  }
  if (s.terraform) {
    updates.push({ eco: 'terraform', dir: '/' });
  }
  updates.push({ eco: 'github-actions', dir: '/' });
  updates.push({ eco: 'devcontainers', dir: '/' });

  const blocks = updates
    .map(
      ({ eco, dir }) => `  - package-ecosystem: ${eco}
    directory: "${dir}"
    schedule:
      interval: weekly
      day: monday
    cooldown:
      default-days: 7 # supply-chain buffer: skip versions younger than a week
    open-pull-requests-limit: 10
    groups:
      ${eco}-minor-patch:
        update-types: [minor, patch]`,
    )
    .join('\n');
  return `# Managed by star-config. Security updates are always raised immediately;
# version updates wait out a cooldown so freshly-published malicious releases get caught first.
version: 2
updates:
${blocks}
`;
}
