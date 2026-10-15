// @ts-check
/**
 * Formats generated files with the same Prettier config consumers lint with, so scaffolded
 * files pass `star-config lint` on day one. Uses prettier/standalone so it also works
 * inside the single-file binary (no node_modules there).
 */
import * as babel from 'prettier/plugins/babel';
import * as estree from 'prettier/plugins/estree';
import * as markdown from 'prettier/plugins/markdown';
import * as typescript from 'prettier/plugins/typescript';
import * as yaml from 'prettier/plugins/yaml';
import { format } from 'prettier/standalone';
import config from '../configs/prettier.config.mjs';

/** @type {Array<[RegExp, string]>} */
const PARSERS = [
  [/(^|\/)package\.json$/, 'json-stringify'],
  [/\.jsonc?$/, 'json'],
  [/\.(md|mdx)$/, 'markdown'],
  [/\.ya?ml$/, 'yaml'],
  [/\.[cm]?jsx?$/, 'babel'],
  [/\.[cm]?tsx?$/, 'typescript'],
];

/**
 * @param {string} rel  repo-relative path (decides the parser)
 * @param {string} content
 * @returns {Promise<string>}
 */
export async function formatGenerated(rel, content) {
  const parser = PARSERS.find(([re]) => re.test(rel))?.[1];
  if (!parser) {
    return content;
  }
  const overrides = (config.overrides ?? [])
    .filter((o) =>
      // Shipped overrides are extension globs (e.g. *.yaml), including dotfiles.
      [o.files].flat().some((g) => {
        const glob = String(g);
        return rel.endsWith(glob.startsWith('*') ? glob.slice(1) : glob);
      }),
    )
    .reduce((acc, o) => ({ ...acc, ...o.options }), {});
  const { overrides: _ignored, ...base } = config;
  return format(content, {
    ...base,
    ...overrides,
    parser,
    filepath: rel,
    plugins: [babel, estree, markdown, typescript, yaml],
  });
}
