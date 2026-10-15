// star-config — Prettier 3. Repo usage (prettier.config.mjs):
//   export { default } from 'star-config/prettier';
/** @type {import('prettier').Config} */
const config = {
  printWidth: 100,
  singleQuote: true,
  trailingComma: 'all',
  semi: true,
  arrowParens: 'always',
  endOfLine: 'lf',
  overrides: [
    { files: ['*.md', '*.mdx'], options: { proseWrap: 'preserve' } },
    { files: ['*.yml', '*.yaml'], options: { singleQuote: false } },
  ],
};

export default config;
