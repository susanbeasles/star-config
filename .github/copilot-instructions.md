# Copilot instructions

Follow [AGENTS.md](../AGENTS.md) — it is the source of truth for commands, conventions, and the
security rules below.

- Never put PHI/PII, secrets, or real patient identifiers in code, tests, logs, or suggestions.
- Prefer existing utilities and dependencies; no new dependency without a reason.
- Code must pass `.star/run check` (lint, format, tests, security audit).
