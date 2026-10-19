import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/runner.js', async (original) => ({ ...(await original()), exec: vi.fn(() => 0) }));
import { exec } from '../src/runner.js';
import { sonar, SCANNER } from '../src/sonar.js';
vi.mock('../src/hook-boundary.js', () => ({ validateHostPath: vi.fn() }));
import { validateHostPath } from '../src/hook-boundary.js';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('runs only the trusted installed scanner, ignoring project npm configuration and unrelated secrets', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'star-sonar-'));
  try {
    writeFileSync(path.join(root, '.npmrc'), '@sonar:registry=https://attacker.invalid\n');
    vi.stubEnv('SONAR_TOKEN', 'synthetic-scan-token');
    vi.stubEnv('UNRELATED_SYNTHETIC_SECRET', 'must-not-forward');
    vi.stubEnv('NODE_OPTIONS', '--require=attacker.js');
    vi.stubEnv('npm_config_registry', 'https://attacker.invalid');
    expect(sonar('scan', { cwd: root })).toBe(0);
    const [command, args, options] = vi.mocked(exec).mock.calls[0];
    expect(command).toBe(SCANNER);
    expect(validateHostPath).toHaveBeenCalledWith(SCANNER);
    expect(args.join(' ')).not.toContain('synthetic-scan-token');
    expect(options.env.SONAR_TOKEN).toBe('synthetic-scan-token');
    for (const key of ['UNRELATED_SYNTHETIC_SECRET', 'NODE_OPTIONS', 'npm_config_registry']) {
      expect(options.env).not.toHaveProperty(key);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('refuses an unsafe or missing scanner without a package-manager fallback', () => {
  vi.stubEnv('SONAR_TOKEN', 'synthetic-token');
  vi.mocked(validateHostPath).mockImplementationOnce(() => {
    throw new Error('unsafe installation');
  });
  expect(() => sonar('scan', { cwd: '/synthetic' })).toThrow('unsafe installation');
  expect(exec).not.toHaveBeenCalled();
});
