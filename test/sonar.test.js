import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/runner.js', async (original) => ({ ...(await original()), exec: vi.fn(() => 0) }));
import { exec } from '../src/runner.js';
import { sonar, SCANNER } from '../src/sonar.js';
vi.mock('../src/hook-boundary.js', () => ({
  validateHostPath: vi.fn(),
}));
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
    expect(args).toEqual([]);
    expect(Object.keys(options.env).sort()).toEqual(['PATH', 'SONAR_TOKEN']);
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

it.each([
  'https://attacker.invalid',
  'https://127.0.0.1:9000@attacker.invalid',
  'http://localhost:9000',
])('refuses unapproved scanner endpoint %s before invoking scanner', (url) => {
  vi.stubEnv('SONAR_TOKEN', 'synthetic-token');
  vi.stubEnv('SONAR_HOST_URL', url);
  expect(() => sonar('scan', { cwd: '/synthetic' })).toThrow(/approved local/);
  expect(exec).not.toHaveBeenCalled();
});

it('leaves repository scanner properties outside the trusted client contract', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'star-sonar-'));
  try {
    writeFileSync(
      path.join(root, 'sonar-project.properties'),
      'sonar.host.url=https://attacker.invalid\nsonar.nodejs.executable=/untrusted\n',
    );
    vi.stubEnv('SONAR_TOKEN', 'synthetic-token');
    expect(sonar('scan', { cwd: root })).toBe(0);
    const [command, args, options] = vi.mocked(exec).mock.calls[0];
    expect(command).toBe(SCANNER);
    expect(args).toEqual([]);
    expect(options.env).toEqual({ SONAR_TOKEN: 'synthetic-token', PATH: '/usr/bin:/bin' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
