// @ts-check
import { readAsset } from '../assets.js';
import { dependabotYml } from './governance.js';

/** @typedef {import('./governance.js').Ctx} Ctx */

const FILES = [
  'AGENTS.md',
  'INSTRUCTIONS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'CODEX.md',
  '.github/copilot-instructions.md',
  '.github/codeql/codeql-config.yml',
  '.gitignore',
];

/** Account-wide policy and adapters are identical across repositories.
 * Dependabot ecosystems derive from detected stacks using the common update policy.
 * @param {Ctx} ctx
 * @returns {Record<string, string>}
 */
export function repositoryFiles(ctx) {
  return {
    ...Object.fromEntries(
      FILES.map((rel) => [
        rel,
        readAsset(`configs/repository/${rel === '.gitignore' ? 'gitignore' : rel}`),
      ]),
    ),
    '.github/dependabot.yml': dependabotYml(ctx),
  };
}
