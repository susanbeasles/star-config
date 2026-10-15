# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- After every edit, a PostToolUse hook runs `.star/run agent-hook` on the changed file: it formats
  and lints that file. If it reports errors, fix them before moving on.
- Use plan mode for changes touching auth, data access, infra, or more than ~5 files.
- Permissions in `.claude/settings.json` deny reading secrets; don't work around them.
