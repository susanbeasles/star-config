import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

const BOT_ID = 49699333;
const SHA = /^[a-f0-9]{40}$/;

// Privileged automation reads GitHub metadata only. It never executes PR code.
function revisionsOnly(patch, pattern) {
  if (!patch) {
    return false;
  }
  const removed = [];
  const added = [];
  for (const line of patch.split('\n')) {
    if (!/^[+-]/.test(line)) {
      continue;
    }
    const match = line.slice(1).match(pattern);
    if (!match) {
      return false;
    }
    (line[0] === '-' ? removed : added).push(match[1]);
  }
  return removed.length > 0 && isDeepStrictEqual(removed, added);
}

export function eligibleFiles(files) {
  return (
    files.length > 0 &&
    files.every((file) => {
      if (file.status !== 'modified') {
        return false;
      }
      if (['package.json', 'package-lock.json'].includes(file.filename)) {
        return true;
      }
      if (
        [
          '.github/workflows/ci.yml',
          '.github/workflows/release.yml',
          '.github/workflows/dependabot-merge.yml',
        ].includes(file.filename)
      ) {
        return revisionsOnly(
          file.patch,
          /^(\s*- uses: [\w-]+\/[\w./-]+)@[a-f0-9]{40}(?: # v[\w.+-]+)?$/,
        );
      }
      if (file.filename === 'configs/sonarqube-compose.yml') {
        return revisionsOnly(
          file.patch,
          /^(\s*image: (?:postgres|sonarqube):\d+)(?:\.\d+)*(?:-[\w.-]+)?(?:@sha256:[a-f0-9]{64})?$/,
        );
      }
      return false;
    })
  );
}

// Only existing dependency versions may change; scripts/config/engines cannot ride along.
export function dependencyVersionsOnly(before, after) {
  const old = structuredClone(before);
  const next = structuredClone(after);
  let changed = false;
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const name of Object.keys(old[section] ?? {})) {
      if (old[section][name] === next[section]?.[name]) {
        continue;
      }
      if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(next[section]?.[name] ?? '')) {
        return false;
      }
      old[section][name] = next[section][name];
      changed = true;
    }
  }
  return changed && isDeepStrictEqual(old, next);
}

function eligiblePr(pr, repository, base) {
  const head = pr.head?.sha;
  return !(
    pr.state !== 'open' ||
    pr.draft ||
    !SHA.test(head ?? '') ||
    pr.user?.id !== BOT_ID ||
    pr.user?.login !== 'dependabot[bot]' ||
    pr.head?.repo?.full_name !== repository ||
    pr.base?.ref !== base ||
    pr.base?.repo?.full_name !== repository ||
    pr.changed_files < 1 ||
    pr.changed_files > 100 ||
    pr.commits < 1 ||
    pr.commits > 100
  );
}

async function trustedChanges(api, root, pr) {
  const head = pr.head.sha;
  const commits = await api(`${root}/pulls/${pr.number}/commits?per_page=100`);
  if (
    commits.length !== pr.commits ||
    commits.some(
      (c) =>
        c.author?.id !== BOT_ID ||
        c.author?.login !== 'dependabot[bot]' ||
        c.committer?.login !== 'web-flow' ||
        c.commit?.verification?.verified !== true,
    )
  ) {
    return false;
  }

  const files = await api(`${root}/pulls/${pr.number}/files?per_page=100`);
  if (files.length !== pr.changed_files || !eligibleFiles(files)) {
    return false;
  }
  if (files.some((f) => f.filename === 'package.json')) {
    const manifest = async (ref) => {
      const file = await api(`${root}/contents/package.json?ref=${ref}`);
      if (file.encoding !== 'base64') {
        throw new Error('Unexpected manifest encoding');
      }
      return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    };
    if (!dependencyVersionsOnly(await manifest(pr.base.sha), await manifest(head))) {
      return false;
    }
  }

  return true;
}

async function passingCI(api, root, workflow, head) {
  const runs = await api(
    `${root}/actions/workflows/${workflow.id}/runs?event=pull_request&head_sha=${head}&per_page=100`,
  );
  const latest = runs.workflow_runs.sort((a, b) => b.id - a.id)[0];
  if (
    !latest ||
    latest.event !== 'pull_request' ||
    latest.head_sha !== head ||
    latest.path !== '.github/workflows/ci.yml' ||
    latest.workflow_id !== workflow.id ||
    latest.status !== 'completed' ||
    latest.conclusion !== 'success'
  ) {
    return false;
  }
  const jobs = await api(`${root}/actions/runs/${latest.id}/jobs?filter=latest&per_page=100`);
  if (
    jobs.total_count !== jobs.jobs.length ||
    !jobs.jobs.some((j) => j.name === 'verify') ||
    jobs.jobs.some((j) => j.status !== 'completed' || j.conclusion !== 'success')
  ) {
    return false;
  }

  return true;
}

async function passingChecks(api, root, head) {
  const checks = await api(`${root}/commits/${head}/check-runs?filter=latest&per_page=100`);
  if (
    checks.total_count !== checks.check_runs.length ||
    !checks.check_runs.length ||
    checks.check_runs.some((c) => c.status !== 'completed' || c.conclusion !== 'success')
  ) {
    return false;
  }
  const statuses = await api(`${root}/commits/${head}/status?per_page=100`);
  if (
    statuses.total_count !== statuses.statuses.length ||
    statuses.statuses.some((s) => s.state !== 'success')
  ) {
    return false;
  }
  return true;
}

async function noChangeRequests(api, root, pr) {
  const reviews = await api(`${root}/pulls/${pr.number}/reviews?per_page=100`);
  if (reviews.length === 100) {
    return false;
  }
  const active = new Map();
  for (const review of reviews) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
      active.set(review.user.id, review.state);
    }
  }
  if ([...active.values()].includes('CHANGES_REQUESTED')) {
    return false;
  }

  return true;
}

async function requestRebase(api, root, pr, base, report) {
  const marker = `<!-- dependabot-base-sync:${pr.head.sha}:${base} -->`;
  const route = `${root}/issues/${pr.number}/comments`;
  const comments = await api(`${route}?per_page=100`);
  if (comments.length === 100 || comments.some((comment) => comment.body?.includes(marker))) {
    return;
  }
  await api(route, { method: 'POST', body: { body: `@dependabot rebase\n\n${marker}` } });
  report(`Requested Dependabot rebase for PR #${pr.number}`);
}

async function readyToPublish(api, repository, base, workflow, number, report) {
  const root = `/repos/${repository}`;
  const pr = await api(`${root}/pulls/${number}`);
  if (
    !eligiblePr(pr, repository, base) ||
    !(await trustedChanges(api, root, pr)) ||
    !(await noChangeRequests(api, root, pr))
  ) {
    return null;
  }
  const branch = await api(`${root}/branches/${encodeURIComponent(base)}`);
  // This mode is for an unprotected base. Never use indirect merges to bypass PR rules.
  if (branch.protected !== false) {
    report(`PR #${number} requires manual integration: default branch is protected.`);
    return null;
  }
  const head = pr.head.sha;
  const comparison = await api(`${root}/compare/${branch.commit.sha}...${head}`);
  if (comparison.behind_by > 0) {
    await requestRebase(api, root, pr, branch.commit.sha, report);
    return null;
  }
  if (
    comparison.behind_by !== 0 ||
    comparison.status !== 'ahead' ||
    !pr.mergeable ||
    !(await passingCI(api, root, workflow, head)) ||
    !(await passingChecks(api, root, head))
  ) {
    return null;
  }
  const current = await api(`${root}/pulls/${number}`);
  if (!eligiblePr(current, repository, base) || current.head.sha !== head || !current.mergeable) {
    return null;
  }
  return pr;
}

export async function reconcile({ api, repository, report = () => {} }) {
  const root = `/repos/${repository}`;
  const repo = await api(root);
  const base = repo.default_branch;
  const workflow = await api(`${root}/actions/workflows/ci.yml`);
  const prs = await api(`${root}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100`);
  for (const candidate of prs) {
    if (candidate.user?.id !== BOT_ID || candidate.user?.login !== 'dependabot[bot]') {
      continue;
    }
    const pr = await readyToPublish(api, repository, base, workflow, candidate.number, report);
    if (!pr) {
      continue;
    }
    const head = pr.head.sha;
    // Publish only the tested commit. A concurrent base advance rejects the fast-forward
    // instead of creating an untested merge commit. GitHub marks the PR merged by ancestry.
    const result = await api(`${root}/git/refs/heads/${encodeURIComponent(base)}`, {
      method: 'PATCH',
      body: { sha: head, force: false },
    });
    if (result.object?.sha !== head) {
      throw new Error(`GitHub declined PR #${pr.number}`);
    }
    report(`Merged Dependabot PR #${pr.number} at ${head}`);
    // One merge per run: other PRs must rebase and pass CI against the new base.
    return pr.number;
  }
  report('No current, fully passing Dependabot update is eligible.');
  return null;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
    throw new Error('Missing GitHub context');
  }
  const api = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`https://api.github.com${route}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`GitHub ${method} ${route}: ${response.status}`);
    }
    return response.json();
  };
  await reconcile({ api, repository, report: (message) => process.stdout.write(`${message}\n`) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
