import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/initialize.js', () => ({ initialize: vi.fn(async () => true) }));
import { initialize } from '../src/initialize.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
beforeEach(() => {
  vi.resetModules();
  vi.mocked(initialize).mockClear();
  vi.stubEnv('INIT_CWD', path.resolve('synthetic-consumer'));
  vi.stubEnv('npm_config_global', 'false');
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
});

it.each(['darwin', 'win32'])(
  'installs on %s without invoking Linux-only initialization',
  async (value) => {
    Object.defineProperty(process, 'platform', { value });
    await import('../bin/postinstall.js');
    expect(initialize).not.toHaveBeenCalled();
  },
);

it('dispatches a local Linux install to the initializer', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  await import('../bin/postinstall.js');
  expect(initialize).toHaveBeenCalledWith(path.resolve('synthetic-consumer'));
});

it('skips global installs', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.stubEnv('npm_config_global', 'true');
  await import('../bin/postinstall.js');
  expect(initialize).not.toHaveBeenCalled();
});
