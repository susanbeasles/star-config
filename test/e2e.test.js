// End-to-end against real tools in a real git repo. Steps whose tool isn't installed are
// skipped by star-config itself (locally) — these tests assert on the ones that are present.
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../src/assets.js';
import { getLanguage } from '../src/languages.js';
import { resolveTool } from '../src/runner.js';
import { makeRepo, out } from './helpers.js';

const has = (lang, i = 0) => Boolean(resolveTool(getLanguage(lang).steps[i], PACKAGE_ROOT));
const hasBin = (tool) => Boolean(resolveTool({ tool, args: {}, install: '' }, PACKAGE_ROOT));

let repo;

beforeAll(() => {
  repo = makeRepo({ linkPackage: true });
  for (const pkg of ['vitest', '@vitest']) {
    symlinkSync(
      path.join(PACKAGE_ROOT, 'node_modules', pkg),
      path.join(repo.root, 'node_modules', pkg),
    );
  }
  repo.put(
    'package.json',
    `${JSON.stringify({ name: 'poly', type: 'module', devDependencies: { vitest: '5.0.4' } }, null, 2)}\n`,
  );
  repo.put('src/math.ts', 'export const add = (a: number, b: number): number => a + b;\n');
  repo.put(
    'src/math.test.ts',
    "import { expect, test } from 'vitest';\nimport { add } from './math';\n\ntest('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n",
  );
  repo.put('pyproject.toml', '[project]\nname = "poly"\nversion = "0.1.0"\n');
  repo.put('svc/__init__.py', '');
  repo.put('svc/app.py', 'def double(x: int) -> int:\n    return x * 2\n');
  repo.put(
    'tests/test_app.py',
    'from svc.app import double\n\n\ndef test_double() -> None:\n    assert double(2) == 4\n',
  );
  repo.put(
    'Cargo.toml',
    '[package]\nname = "poly"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\n',
  );
  repo.put(
    'src/lib.rs',
    'pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {\n        assert_eq!(super::add(1, 2), 3);\n    }\n}\n',
  );
  repo.put('scripts/hello.sh', '#!/usr/bin/env bash\nset -euo pipefail\necho "hello"\n');
  repo.put(
    'test/hello.bats',
    '#!/usr/bin/env bats\n\n@test "hello" {\n  run bash scripts/hello.sh\n  [ "$output" = "hello" ]\n}\n',
  );
  repo.put(
    'Dockerfile',
    'FROM alpine:3.22\nRUN adduser -D app\nUSER app\nCOPY --chown=app scripts/ /app/\n',
  );
  repo.put(
    '.semgrep.yml',
    'rules:\n  - id: no-eval\n    languages: [python]\n    severity: ERROR\n    message: eval is forbidden\n    pattern: eval(...)\n',
  );
  repo.sh('git', ['add', '-A']);
  const setup = repo.cli(['setup', '--no-install', '--owners', '@acme/platform']);
  if (setup.status !== 0) {
    throw new Error(out(setup));
  }
  repo.sh('git', ['add', '-A']);
}, 120_000);
afterAll(() => repo?.cleanup());

describe('setup', () => {
  it('scaffolds every stack and installs hooks without npm/husky', () => {
    for (const f of [
      'AGENTS.md',
      'CLAUDE.md',
      '.claude/settings.json',
      '.codex/config.toml',
      '.github/copilot-instructions.md',
      'SECURITY.md',
      '.github/CODEOWNERS',
      '.github/dependabot.yml',
      '.github/pull_request_template.md',
      'mise.toml',
      '.devcontainer/devcontainer.json',
      'eslint.config.mjs',
      'prettier.config.mjs',
      'ruff.toml',
      'rustfmt.toml',
      'deny.toml',
      '.hadolint.yaml',
      'vitest.config.ts',
      '.star/run',
      '.husky/pre-commit',
    ]) {
      expect(existsSync(path.join(repo.root, f)), f).toBe(true);
    }
    expect(repo.sh('git', ['config', 'core.hooksPath']).stdout.trim()).toBe('.husky');
  });

  it('is idempotent: sync --check reports nothing to do', () => {
    expect(repo.cli(['sync', '--check']).status).toBe(0);
  });

  it('a clean polyglot repo passes lint', () => {
    const res = repo.cli(['lint']);
    expect(res.status, out(res)).toBe(0);
  });
});

describe('lint catches each stack', () => {
  const broken = (rel, content, args = ['lint']) => {
    const original = existsSync(path.join(repo.root, rel))
      ? readFileSync(path.join(repo.root, rel), 'utf8')
      : null;
    repo.put(rel, content);
    repo.sh('git', ['add', '-A']);
    const res = repo.cli(args);
    if (original === null) {
      repo.sh('git', ['rm', '-q', '-f', rel]);
    } else {
      repo.put(rel, original);
      repo.sh('git', ['add', '-A']);
    }
    return res;
  };

  it('ESLint (no-console, eqeqeq) through the shipped flat config', () => {
    const res = broken(
      'src/bad.ts',
      "export function f(x: number): void {\n  if (x == 1) {\n    console.log('phi');\n  }\n}\n",
    );
    expect(res.status).toBe(1);
    expect(out(res)).toMatch(/no-console/);
    expect(out(res)).toMatch(/eqeqeq/);
  });

  it('Prettier formatting drift', () => {
    expect(out(broken('src/ugly.ts', 'export const x = {a:1,b:2}\n'))).toMatch(/Code style issues/);
  });

  it.runIf(has('python', 1))('Ruff (print → T201, eval → S307)', () => {
    const res = broken('svc/bad.py', 'print(eval("1"))\n');
    expect(out(res)).toMatch(/T201|S307/);
  });

  it.runIf(has('shell', 1))('ShellCheck', () => {
    expect(out(broken('scripts/bad.sh', '#!/usr/bin/env bash\necho $1\n'))).toMatch(/SC2086/);
  });

  it.runIf(hasBin('actionlint'))('actionlint on workflows only', () => {
    const res = broken(
      '.github/workflows/bad.yml',
      'on: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ github.event.issue.title }}\n',
    );
    expect(out(res)).toMatch(/actionlint|potentially untrusted/);
  });

  it.runIf(hasBin('hadolint'))('hadolint (ADD → DL3020)', () => {
    expect(out(broken('Dockerfile', 'FROM alpine:3.22\nADD x /x\n'))).toMatch(/DL3020/);
  });

  it.runIf(hasBin('rustfmt'))('rustfmt', () => {
    expect(broken('src/lib.rs', 'pub fn add(a:i32,b:i32)->i32{a+b}\n').status).toBe(1);
  });

  it('format fixes what it can', () => {
    repo.put('src/ugly.ts', 'export const x = {a:1,b:2}\n');
    repo.sh('git', ['add', '-A']);
    expect(repo.cli(['format']).status).toBe(0);
    expect(readFileSync(path.join(repo.root, 'src/ugly.ts'), 'utf8')).toBe(
      'export const x = { a: 1, b: 2 };\n',
    );
    repo.sh('git', ['rm', '-q', '-f', 'src/ugly.ts']);
  });
});

describe('test / build / audit', () => {
  let testOutput = '';

  it('runs every detected test suite', () => {
    const res = repo.cli(['test']);
    testOutput = out(res);
    expect(res.status, testOutput).toBe(0);
    expect(testOutput).toMatch(/node:vitest/);
  }, 180_000);

  it.runIf(hasBin('pytest'))('runs pytest from the repo root', () => {
    expect(testOutput).toMatch(/1 passed/);
  });

  it.runIf(hasBin('cargo'))('runs cargo test', () => {
    expect(testOutput).toMatch(/test tests::adds \.\.\. ok/);
  });

  it.runIf(hasBin('bats'))('runs bats', () => {
    expect(testOutput).toMatch(/ok 1 hello/);
  });

  it.runIf(hasBin('semgrep'))(
    'audit runs SAST and fails on findings',
    () => {
      repo.put('svc/danger.py', 'def run(x: str) -> object:\n    return eval(x)\n');
      repo.sh('git', ['add', '-A']);
      const res = repo.cli(['audit'], { STAR_SEMGREP_CONFIG: '.semgrep.yml' });
      repo.sh('git', ['rm', '-q', '-f', 'svc/danger.py']);
      expect(res.status, out(res)).toBe(1);
      expect(out(res)).toMatch(/eval is forbidden/);
      expect(out(res)).toMatch(/sast:semgrep/);
    },
    180_000,
  );

  it('wrangler-nag gates Cloudflare config in audit', () => {
    repo.put(
      'worker/wrangler.toml',
      'name = "w"\nroutes = [{ pattern = "a.example.com/*", zone_name = "example.com" }]\n[vars]\nAPI_TOKEN = "abc"\n',
    );
    repo.sh('git', ['add', '-A']);
    const res = repo.cli(['audit'], { STAR_SEMGREP_CONFIG: '.semgrep.yml' });
    repo.sh('git', ['rm', '-q', '-f', 'worker/wrangler.toml']);
    expect(out(res)).toMatch(/WR002/);
    expect(out(res)).toMatch(/iac:wrangler-nag/);
  }, 180_000);

  it('fails in CI when a required tool is missing', () => {
    const res = repo.cli(['audit'], {
      CI: 'true',
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    });
    expect(res.status).toBe(1);
    expect(out(res)).toMatch(/gitleaks is required/);
  }, 180_000);
});

describe('hooks', () => {
  it('pre-commit (real git commit) auto-formats staged files and blocks violations', () => {
    repo.put('src/fmt.ts', 'export const y = [1,2,3]\n');
    repo.sh('git', ['add', '-A']);
    const ok = repo.sh('git', ['commit', '-qm', 'feat: initial']);
    expect(ok.status, out(ok)).toBe(0);
    expect(readFileSync(path.join(repo.root, 'src/fmt.ts'), 'utf8')).toBe(
      'export const y = [1, 2, 3];\n',
    );
    expect(repo.sh('git', ['status', '--porcelain']).stdout).toBe('');

    repo.put('src/leak.ts', "export function f(): void {\n  console.log('patient');\n}\n");
    repo.sh('git', ['add', 'src/leak.ts']);
    const bad = repo.sh('git', ['commit', '-qm', 'feat: leak']);
    expect(bad.status).toBe(1);
    expect(out(bad)).toMatch(/no-console/);
    repo.sh('git', ['rm', '-q', '-f', '--cached', 'src/leak.ts']);
  }, 120_000);

  it('agent-hook formats the edited file and returns 2 on lint errors', () => {
    repo.put('src/agent.ts', 'export const z = {a:1}\n');
    const ok = repo.cli(
      ['agent-hook'],
      {},
      JSON.stringify({ tool_input: { file_path: path.join(repo.root, 'src/agent.ts') } }),
    );
    expect(ok.status, out(ok)).toBe(0);
    expect(readFileSync(path.join(repo.root, 'src/agent.ts'), 'utf8')).toBe(
      'export const z = { a: 1 };\n',
    );

    repo.put('src/agent.ts', "export const z = 1;\nconsole.log('x');\n");
    const bad = repo.cli(
      ['agent-hook'],
      {},
      JSON.stringify({ tool_input: { file_path: 'src/agent.ts' } }),
    );
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/reported problems in src\/agent\.ts/);
  }, 60_000);
});
