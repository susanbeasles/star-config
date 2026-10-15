// Dogfood: run this checkout's CLI from source.
import { createLintStagedConfig } from './src/languages.js';

export default createLintStagedConfig({ command: 'node bin/star-config.js' });
