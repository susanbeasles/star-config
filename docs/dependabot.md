# Dependency maintenance

Dependabot checks npm, GitHub Actions, and the SonarQube Compose configuration
weekly. Version updates retain a seven-day cooldown. Actions updates are grouped
so compatible upload/download and runtime changes are tested together.

The `Dependabot merge` workflow runs after CI and hourly to reconcile missed
events. It uses only the built-in GitHub token and default-branch code. It does
not need the repository's optional auto-merge setting, an external service, or a
personal token.

A pull request is merged only when all of these conditions hold:

- It is an open, non-draft, same-repository Dependabot PR targeting the default
  branch, with verified Dependabot commits.
- Its changes are existing npm dependency versions/lockfiles, immutable action
  revisions, or same-major container image updates. Workflow commands,
  permissions, and the merge implementation itself cannot change automatically.
- The latest CI run for the exact head succeeds, including every job, and all
  reported checks/statuses succeed. The head includes the current default branch.
- No active review requests changes. GitHub accepts the merge under current
  repository rules. The merge request includes the checked head SHA to reject a
  concurrent branch update.

Only one PR merges per invocation. Dependabot rebases remaining open PRs; they
must pass CI again. Errors and unsupported changes remain unmerged and are
visible in the workflow log. Run the workflow manually to retry after resolving
a blocker. The automation does not bypass required reviews or branch rules.

PostgreSQL stays on major version 17. The image-only PostgreSQL 18 proposal also
changes the data-directory convention and cannot migrate an existing named
volume. Plan and validate a data migration before upgrading it. Other container
majors remain available for manual review. TypeScript remains below 6.1 to match
the supported parser/plugin peer range.

CI uses Node 24, checks types and coverage, runs lint/security gates, and performs
an artifact upload/download round trip. Release publishing still requires the
existing tag trigger and release environment.
