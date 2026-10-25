import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/initialize.js', () => ({ initialize: vi.fn(async () => true) }));
import { initialize } from '../src/initialize.js';
import { PACKAGE_ROOT } from '../src/assets.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
beforeEach(() => {
  vi.resetModules();
  vi.mocked(initialize).mockClear();
  vi.stubEnv('INIT_CWD', path.dirname(PACKAGE_ROOT));
  vi.stubEnv('npm_config_global', 'false');
  vi.stubEnv('npm_config_local_prefix', '');
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
});

it.each(['win32'])('installs on %s without invoking Linux-only initialization', async (value) => {
  Object.defineProperty(process, 'platform', { value });
  await import('../bin/postinstall.js');
  expect(initialize).not.toHaveBeenCalled();
});

it('dispatches a local Linux install to the initializer', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  await import('../bin/postinstall.js');
  expect(initialize).toHaveBeenCalledWith(path.dirname(PACKAGE_ROOT), {
    requireDependency: false,
    packageInstall: true,
  });
});

it('skips global installs', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.stubEnv('npm_config_global', 'true');
  await import('../bin/postinstall.js');
  expect(initialize).not.toHaveBeenCalled();
});

it('supports automatic macOS initialization', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  await import('../bin/postinstall.js');
  expect(initialize).toHaveBeenCalledWith(path.dirname(PACKAGE_ROOT), {
    requireDependency: false,
    packageInstall: true,
  });
});

it('honors an explicit initialization opt-out', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.stubEnv('STAR_CONFIG_SKIP_INIT', '1');
  await import('../bin/postinstall.js');
  expect(initialize).not.toHaveBeenCalled();
});

it('does not initialize the project when npm is installing the package in its execution cache', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.stubEnv('INIT_CWD', path.resolve('unrelated-project'));
  await import('../bin/postinstall.js');
  expect(initialize).not.toHaveBeenCalled();
});
