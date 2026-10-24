#!/usr/bin/env node
// @ts-check
import path from 'node:path';
import { initialize } from '../src/initialize.js';

const target = process.env.INIT_CWD;
if (target && path.isAbsolute(target) && process.env.npm_config_global !== 'true') {
  initialize(path.resolve(target)).catch((error) => {
    process.stderr.write(
      `star-config initialization failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
