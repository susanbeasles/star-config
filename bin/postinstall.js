#!/usr/bin/env node
// @ts-check
import path from 'node:path';
import { initialize } from '../src/initialize.js';
import { PACKAGE_ROOT } from '../src/assets.js';

const target = process.env.npm_config_local_prefix || process.env.INIT_CWD;
if (
  ['linux', 'darwin'].includes(process.platform) &&
  target &&
  path.isAbsolute(target) &&
  path.resolve(target) !== PACKAGE_ROOT &&
  PACKAGE_ROOT.startsWith(`${path.resolve(target)}${path.sep}`) &&
  process.env.npm_config_global !== 'true' &&
  process.env.STAR_CONFIG_SKIP_INIT !== '1'
) {
  initialize(path.resolve(target), { requireDependency: false, packageInstall: true }).catch(
    (error) => {
      process.stderr.write(
        `star-config initialization failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
