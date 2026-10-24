import { starConfig } from './configs/eslint.config.mjs';

export default [
  ...starConfig(),
  { ignores: ['test/fixtures/**', 'dist/**'] },
  {
    // The CLI talks to humans on stderr through log(); runner/setup are CLI internals.
    files: ['src/**', 'bin/**', 'test/**', 'scripts/**'],
    rules: {
      'no-console': 'error',
      // This is a tool orchestrator: resolving binaries from PATH is the product.
      // Every spawn is argv-only (no shell), which is the injection control that matters.
      'sonarjs/no-os-command-from-path': 'off',
    },
  },
];
