// @ts-check
/** `star-config/lint-staged` — default export is the eslint-profile config. */
import { createLintStagedConfig } from './languages.js';

export { createLintStagedConfig };
export default createLintStagedConfig({ command: '.star/run' });
