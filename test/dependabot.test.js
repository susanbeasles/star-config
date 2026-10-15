import { describe, expect, it } from 'vitest';
import { dependencyVersionsOnly, eligibleFiles, reconcile } from '../scripts/dependabot-merge.mjs';

const oldPin = 'a'.repeat(40);
const newPin = 'b'.repeat(40);
const workflow = (extra = '') => ({
  filename: '.github/workflows/ci.yml',
  status: 'modified',
  patch: `@@ -1 +1 @@\n-      - uses: actions/checkout@${oldPin} # v7\n+      - uses: actions/checkout@${newPin} # v7${extra}`,
});

describe('npm change boundary', () => {
  const before = { scripts: { test: 'vitest' }, dependencies: { yaml: '2.9.1' } };
  it('accepts an existing package version update', () => {
    expect(dependencyVersionsOnly(before, { ...before, dependencies: { yaml: '2.9.2' } })).toBe(
      true,
    );
  });
  it.each([
    { scripts: { test: 'curl example.invalid' }, dependencies: { yaml: '2.9.2' } },
    { ...before, dependencies: { yaml: 'https://example.invalid/pkg.tgz' } },
    { ...before, dependencies: { yaml: '2.9.1', injected: '1.0.0' } },
    { ...before, dependencies: {} },
  ])('rejects non-version manifest changes', (after) => {
    expect(dependencyVersionsOnly(before, after)).toBe(false);
  });
});

// Fake only the GitHub API boundary. The full production decision and merge payload run.
function githubFixture() {
  const repository = 'example/repository';
  const root = `/repos/${repository}`;
  const head = 'c'.repeat(40);
  const base = 'd'.repeat(40);
  const bot = { id: 49699333, login: 'dependabot[bot]' };
  const pr = {
    number: 2,
    user: bot,
    state: 'open',
    draft: false,
    mergeable: true,
    head: { sha: head, repo: { full_name: repository } },
    base: { ref: 'main', sha: base, repo: { full_name: repository } },
    changed_files: 1,
    commits: 1,
  };
  const run = {
    id: 10,
    event: 'pull_request',
    head_sha: head,
    workflow_id: 20,
    path: '.github/workflows/ci.yml',
    status: 'completed',
    conclusion: 'success',
  };
  const job = { name: 'verify', status: 'completed', conclusion: 'success' };
  const responses = {
    [root]: { default_branch: 'main' },
    [`${root}/actions/workflows/ci.yml`]: { id: 20 },
    [`${root}/pulls?state=open&base=main&per_page=100`]: [pr],
    [`${root}/pulls/2`]: pr,
    [`${root}/pulls/2/commits?per_page=100`]: [
      {
        author: bot,
        committer: { login: 'web-flow' },
        commit: { verification: { verified: true } },
      },
    ],
    [`${root}/pulls/2/files?per_page=100`]: [workflow()],
    [`${root}/actions/workflows/20/runs?event=pull_request&head_sha=${head}&per_page=100`]: {
      workflow_runs: [run],
    },
    [`${root}/actions/runs/10/jobs?filter=latest&per_page=100`]: { total_count: 1, jobs: [job] },
    [`${root}/branches/main`]: { commit: { sha: base }, protected: false },
    [`${root}/compare/${base}...${head}`]: { status: 'ahead', behind_by: 0 },
    [`${root}/commits/${head}/check-runs?filter=latest&per_page=100`]: {
      total_count: 1,
      check_runs: [job],
    },
    [`${root}/commits/${head}/status?per_page=100`]: { total_count: 0, statuses: [] },
    [`${root}/pulls/2/reviews?per_page=100`]: [],
    [`${root}/issues/2/comments?per_page=100`]: [],
  };
  const writes = [];
  const api = async (route, options = {}) => {
    if (options.method) {
      writes.push({ route, ...options });
      return { object: { sha: head } };
    }
    if (!Object.hasOwn(responses, route)) {
      throw new Error(`Unexpected route ${route}`);
    }
    return structuredClone(responses[route]);
  };
  return { api, repository, responses, root, head, base, pr, run, job, writes };
}

describe('autonomous merge gate', () => {
  it('fast-forwards main to the exact tested commit without forcing', async () => {
    const f = githubFixture();
    expect(await reconcile(f)).toBe(2);
    expect(f.writes).toEqual([
      {
        route: '/repos/example/repository/git/refs/heads/main',
        method: 'PATCH',
        body: { sha: f.head, force: false },
      },
    ]);
  });
  it.each([
    [
      'human author',
      (f) => {
        f.pr.user.id = 42;
      },
    ],
    [
      'fork head',
      (f) => {
        f.pr.head.repo.full_name = 'other/repository';
      },
    ],
    [
      'draft',
      (f) => {
        f.pr.draft = true;
      },
    ],
    [
      'CI failed',
      (f) => {
        f.run.conclusion = 'failure';
      },
    ],
    [
      'CI stale head',
      (f) => {
        f.run.head_sha = f.base;
      },
    ],
    [
      'CI still running',
      (f) => {
        f.run.status = 'in_progress';
      },
    ],
    [
      'skipped job',
      (f) => {
        f.job.conclusion = 'skipped';
      },
    ],
    [
      'unsigned commit',
      (f) => {
        f.responses[`${f.root}/pulls/2/commits?per_page=100`][0].commit.verification.verified =
          false;
      },
    ],
    [
      'newer failed run',
      (f) => {
        f.responses[
          `${f.root}/actions/workflows/20/runs?event=pull_request&head_sha=${f.head}&per_page=100`
        ].workflow_runs.push({ ...f.run, id: 11, conclusion: 'failure' });
      },
    ],
    [
      'protected base',
      (f) => {
        f.responses[`${f.root}/branches/main`].protected = true;
      },
    ],
    [
      'truncated checks',
      (f) => {
        f.responses[
          `${f.root}/commits/${f.head}/check-runs?filter=latest&per_page=100`
        ].total_count = 101;
      },
    ],
    [
      'failed status',
      (f) => {
        f.responses[`${f.root}/commits/${f.head}/status?per_page=100`] = {
          total_count: 1,
          statuses: [{ state: 'failure' }],
        };
      },
    ],
    [
      'requested changes',
      (f) => {
        f.responses[`${f.root}/pulls/2/reviews?per_page=100`] = [
          { user: { id: 3 }, state: 'CHANGES_REQUESTED' },
        ];
      },
    ],
  ])('leaves %s unmerged', async (_, change) => {
    const f = githubFixture();
    change(f);
    expect(await reconcile(f)).toBeNull();
    expect(f.writes).toEqual([]);
  });
  it('does not fall back when GitHub rejects a concurrent base update', async () => {
    const f = githubFixture();
    const api = f.api;
    f.api = (route, options) => {
      if (options?.method) {
        throw new Error('GitHub 422: not a fast forward');
      }
      return api(route, options);
    };
    await expect(reconcile(f)).rejects.toThrow('not a fast forward');
    expect(f.writes).toEqual([]);
  });
  it('requests a rebase of a trusted stale PR even when CI fails or it conflicts', async () => {
    const f = githubFixture();
    f.pr.mergeable = false;
    f.run.conclusion = 'failure';
    f.responses[`${f.root}/compare/${f.base}...${f.head}`].behind_by = 1;
    expect(await reconcile(f)).toBeNull();
    expect(f.writes).toEqual([
      {
        route: `${f.root}/issues/2/comments`,
        method: 'POST',
        body: {
          body: `@dependabot rebase\n\n<!-- dependabot-base-sync:${f.head}:${f.base} -->`,
        },
      },
    ]);
  });
  it.each(['duplicate', 'truncated'])('does not repeat a %s rebase request', async (kind) => {
    const f = githubFixture();
    f.responses[`${f.root}/compare/${f.base}...${f.head}`].behind_by = 1;
    f.responses[`${f.root}/issues/2/comments?per_page=100`] =
      kind === 'duplicate'
        ? [{ body: `<!-- dependabot-base-sync:${f.head}:${f.base} -->` }]
        : Array.from({ length: 100 }, () => ({ body: '' }));
    expect(await reconcile(f)).toBeNull();
    expect(f.writes).toEqual([]);
  });
  it('rechecks the PR before publishing and refuses a replaced head', async () => {
    const f = githubFixture();
    const api = f.api;
    let reads = 0;
    f.api = async (route, options) => {
      const value = await api(route, options);
      if (route === `${f.root}/pulls/2` && ++reads === 2) {
        value.head.sha = 'e'.repeat(40);
      }
      return value;
    };
    expect(await reconcile(f)).toBeNull();
    expect(f.writes).toEqual([]);
  });
});

describe('Dependabot change boundary', () => {
  it('admits an immutable action revision update', () => {
    expect(eligibleFiles([workflow()])).toBe(true);
  });
  it.each(
    [
      [],
      [{ filename: 'src/index.js', status: 'modified', patch: '-old\n+new' }],
      [workflow('\n+      - run: curl attacker.invalid')],
      [{ ...workflow(), patch: workflow().patch.replace(newPin, 'v7') }],
      [{ ...workflow(), status: 'added' }],
      [{ ...workflow(), patch: undefined }],
      [{ filename: 'scripts/dependabot-merge.mjs', status: 'modified', patch: '-old\n+new' }],
    ].map((files) => ({ files })),
  )('rejects changes outside dependency revisions: $files', ({ files }) => {
    expect(eligibleFiles(files)).toBe(false);
  });
  it('admits npm manifests and lockfiles together', () => {
    expect(
      eligibleFiles([
        { filename: 'package.json', status: 'modified' },
        { filename: 'package-lock.json', status: 'modified' },
      ]),
    ).toBe(true);
  });
  it('admits only same-major database image updates', () => {
    const file = { filename: 'configs/sonarqube-compose.yml', status: 'modified' };
    expect(
      eligibleFiles([
        { ...file, patch: '-    image: postgres:17.6-alpine\n+    image: postgres:17.7-alpine' },
      ]),
    ).toBe(true);
    expect(
      eligibleFiles([
        { ...file, patch: '-    image: postgres:17-alpine\n+    image: postgres:18-alpine' },
      ]),
    ).toBe(false);
  });
});
