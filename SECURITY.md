# Security Policy

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** (Security → Report a vulnerability). Please do **not** open a public issue, PR, or discussion.

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

| Control                    | Tool                                      | Where          |
| -------------------------- | ----------------------------------------- | -------------- |
| Secret scanning            | Gitleaks (redacted output)                | pre-commit, CI |
| Dependency vulnerabilities | Trivy, npm audit                          | CI, Dependabot |
| Static analysis (SAST)     | Semgrep, eslint-plugin-sonarjs, SonarQube | CI, IDE        |
| IaC misconfiguration       | Trivy                                     | CI             |
| Dependency updates         | Dependabot with a 7-day cooldown          | weekly         |

Tooling is managed by [star-config](https://www.npmjs.com/package/star-config) v0.2.0.
