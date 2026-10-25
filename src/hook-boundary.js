// @ts-check
import { lstatSync } from 'node:fs';
import path from 'node:path';

export const GUARD = '/opt/agent-guard/bin/agent-guard';
export const HOOKS = '/opt/agent-guard/git-hooks';

/** Dispatch only; the administrator-installed runner owns isolation and check policy.
 * @param {'pre-commit' | 'pre-push' | 'post-edit' | 'stop'} phase
 */
export function guardCommand(phase) {
  const args = phase === 'pre-commit' || phase === 'pre-push' ? ' "$@"' : '';
  return `if [ ! -x ${GUARD} ]; then echo 'agent-guard is unavailable: ask the host administrator to install the reviewed isolated runner at ${GUARD}; no checkout fallback is permitted.' >&2; exit 127; fi; exec ${GUARD} check ${phase}${args}`;
}

/** Validate every component, refusing symlinks and worker-owned installations.
 * The host administrator must also protect dependencies, policy and client configuration.
 * @param {string} target
 * @param {boolean} directory
 */
export function validateHostPath(target, directory = false) {
  const parts = target.split('/').filter(Boolean);
  let current = '/';
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    const isDirectory = index < parts.length - 1 || directory;
    if (
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 ||
      stat.isSymbolicLink() ||
      (isDirectory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o111) === 0
    ) {
      throw new Error(
        `Unsafe host installation: ${current} must be root-owned, executable, not writable by group/others, and not a symlink.`,
      );
    }
  }
}
