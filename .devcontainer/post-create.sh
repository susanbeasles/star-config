#!/usr/bin/env bash
# Managed by star-config: provisions a Codespace / devcontainer.
set -euo pipefail
if ! command -v mise >/dev/null 2>&1; then
  curl -fsSL https://mise.run | sh
  # shellcheck disable=SC2016 # expanded later by the interactive shell, on purpose
  echo 'eval "$(~/.local/bin/mise activate bash)"' >>~/.bashrc
  export PATH="$HOME/.local/bin:$PATH"
fi
mise trust --yes
mise install --yes
if [[ -f package.json ]]; then
  npm ci --no-audit --no-fund
fi
if [[ ! -x node_modules/.bin/star-config ]] && ! command -v star-config >/dev/null 2>&1; then
  curl -fsSL https://install.susanb.dev | sh
fi
.star/run setup --no-scaffold
