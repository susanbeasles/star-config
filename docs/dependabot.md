# Dependency maintenance

Dependabot checks npm, GitHub Actions, and the runtime Docker configuration
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
  revisions. Runtime image updates require review. Workflow commands,
  permissions, and the merge implementation itself cannot change automatically.
- The latest CI run for the exact head succeeds, including every job, and all
  reported checks/statuses succeed. The head includes the current default branch.
- No active review requests changes, the default branch is unprotected, and the
  PR still has the checked head. The workflow fast-forwards the default branch to
  that exact tested commit with `force: false`. If the base advances concurrently,
  GitHub rejects the update instead of creating an untested merge combination.
  GitHub marks the PR merged once its commits are reachable from the base.

Only one PR merges per invocation. For trusted PRs behind the base, the workflow
requests `@dependabot rebase`, once per head/base pair, even if stale CI fails or
the branch conflicts. They must pass CI again. Errors and unsupported changes
remain unmerged and are visible in the workflow log. Run the workflow manually
to retry after resolving a blocker. A protected default branch stops automatic
integration; enabling protection requires choosing an integration mode that
enforces those rules. The automation never force-pushes or bypasses branch rules.

TypeScript remains below 6.1 to match
the supported parser/plugin peer range.

CI uses Node 24, checks types and coverage, runs lint/security gates, and performs
an artifact upload/download round trip. Release publishing still requires the
existing tag trigger and release environment.
