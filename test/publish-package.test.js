import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
const argv = process.argv;
const exitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.mocked(spawnSync).mockReset();
  vi.mocked(readFileSync).mockReturnValue(Buffer.from('synthetic-package'));
  vi.stubEnv('NODE_AUTH_TOKEN', '');
  vi.stubEnv('NPM_TOKEN', '');
  vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', 'https://synthetic.invalid/oidc');
  vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'synthetic-test-placeholder');
  process.argv = ['node', 'scripts/publish-package.mjs', 'assets/package.tgz', '0.3.0'];
});
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.unstubAllEnvs();
});

it('publishes a relative artifact as an absolute local tarball rather than a Git repository spec', async () => {
  vi.mocked(spawnSync)
    .mockReturnValueOnce({ status: 1, stderr: 'E404', stdout: '' })
    .mockReturnValueOnce({ status: 0, stderr: '', stdout: '' });
  await import('../scripts/publish-package.mjs');
  const [, args, options] = vi.mocked(spawnSync).mock.calls[1];
  expect(args.slice(0, 2)).toEqual(['publish', path.resolve('assets/package.tgz')]);
  expect(args).toContain('--provenance');
  expect(args.slice(-2)).toEqual(['--registry', 'https://registry.npmjs.org']);
  expect(options.shell).toBe(false);
});

it('propagates npm publication failure', async () => {
  vi.mocked(spawnSync)
    .mockReturnValueOnce({ status: 1, stderr: 'E404', stdout: '' })
    .mockReturnValueOnce({ status: 1, stderr: '', stdout: '' });
  await import('../scripts/publish-package.mjs');
  expect(process.exitCode).toBe(1);
});
