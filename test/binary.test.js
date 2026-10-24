import assert from 'node:assert/strict';
// The single-file binary in a repo with no Node at all (Python + Terraform + shell).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../src/assets.js';
import { makeRepo, out } from './helpers.js';

const BIN = path.join(PACKAGE_ROOT, 'dist', `star-config-linux-${process.arch}`);
const HAS_BIN = process.platform === 'linux' && existsSync(BIN);

let repo;
const run = (args, env = {}) => repo.sh(BIN, args, { CI: '', ...env });

describe.runIf(HAS_BIN)('star-config binary (no node_modules)', () => {
  beforeAll(() => {
    repo = makeRepo();
    repo.put('requirements.txt', '');
    repo.put('app/main.py', 'def handler() -> str:\n    return "ok"\n');
    repo.put(
      'tests/test_main.py',
      'from app.main import handler\n\n\ndef test_handler() -> None:\n    assert handler() == "ok"\n',
    );
    repo.put('infra/main.tf', 'terraform {\n  required_version = ">= 1.9"\n}\n');
    repo.put('bin/deploy.sh', '#!/usr/bin/env bash\nset -euo pipefail\necho deploy\n');
    repo.sh('git', ['add', '-A']);
    const res = run(['setup', '--no-install']);
    if (res.status !== 0) {
      assert.match(out(res), /Host agent-guard installation is unavailable or unsafe/);
      const synced = run(['sync']);
      assert.equal(synced.status, 0, out(synced));
    }
    repo.sh('git', ['add', '-A']);
  }, 120_000);
  afterAll(() => repo?.cleanup());

  it('reports its version and detects stacks', () => {
    expect(run(['--version']).stdout.trim()).toBe(
      JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version,
    );
    expect(out(run(['doctor']))).toMatch(/Python \(pip\) · Shell · Terraform/);
  });

  it('copies configs instead of extending node_modules (there is none)', () => {
    expect(readFileSync(path.join(repo.root, 'ruff.toml'), 'utf8')).toMatch(/select = \[/);
    expect(existsSync(path.join(repo.root, 'eslint.config.mjs'))).toBe(false);
    expect(readFileSync(path.join(repo.root, 'mise.toml'), 'utf8')).toMatch(/tflint = /);
    expect(readFileSync(path.join(repo.root, 'AGENTS.md'), 'utf8')).toMatch(/Authority and trust/);
    expect(readFileSync(path.join(repo.root, '.github/codeql/codeql-config.yml'), 'utf8')).toMatch(
      /security-extended/,
    );
  });

  it('lints and tests with native tools', () => {
    const lint = run(['lint']);
    expect(lint.status, out(lint)).toBe(0);
    const test = run(['test']);
    expect(test.status, out(test)).toBe(0);
    expect(out(test)).toMatch(/1 passed/);
  }, 120_000);

  it('keeps the fixed host boundary in binary-generated hooks', () => {
    repo.put('app/util.py', 'x  =  1\n');
    const hook = repo.sh('/bin/sh', ['.husky/pre-commit']);
    expect(hook.status, out(hook)).not.toBe(0);
    expect(out(hook)).toMatch(/agent-guard is unavailable/);
    expect(readFileSync(path.join(repo.root, 'app/util.py'), 'utf8')).toBe('x  =  1\n');
  });
});
