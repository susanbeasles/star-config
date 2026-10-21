import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { devcontainerJson, postCreateSh } from '../src/templates/devenv.js';
it('does not automatically run checkout-controlled provisioning on container creation', () => {
  const config = JSON.parse(
    devcontainerJson({ repoName: 'synthetic', stacks: { node: { pm: 'npm' } } }),
  );
  expect(config).not.toHaveProperty('postCreateCommand');
  expect(config).not.toHaveProperty('onCreateCommand');
});
it('legacy post-create entry refuses before dependency or setup commands', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'star-devcontainer-preflight-'));
  try {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { prepare: 'touch lifecycle-ran' } }),
    );
    const script = postCreateSh();
    expect(script).not.toMatch(/npm ci|mise (trust|install)|curl|\.star\/run/);
    const result = spawnSync('bash', ['-c', script], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain('reviewed host runner');
    expect(existsSync(path.join(root, 'lifecycle-ran'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
