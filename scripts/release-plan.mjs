import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const parse = (version) => {
  const match = VERSION.exec(version);
  if (!match) {
    throw new Error(`Invalid stable version: ${version}`);
  }
  return match.slice(1).map(Number);
};
export const compare = (a, b) => {
  const left = parse(a);
  const right = parse(b);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
};

/** Every main push releases. Features bump minor, breaking changes major; other changes patch. */
export function nextVersion(current, messages) {
  const [major, minor, patch] = parse(current);
  if (
    messages.some(
      (message) =>
        /^[a-z][\w-]*(?:\([^\r\n)]+\))?!: /.test(message) || /^BREAKING[ -]CHANGE: /m.test(message),
    )
  ) {
    return `${major + 1}.0.0`;
  }
  if (messages.some((message) => /^feat(?:\([^\r\n)]+\))?: /.test(message))) {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

export function releasePlan(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const sha = git('rev-parse', 'HEAD');
  const tags = git('tag', '--merged', 'HEAD')
    .split('\n')
    .filter((tag) => VERSION.test(tag))
    .sort(compare);
  const baseTag = tags.at(-1);
  const current =
    baseTag && compare(baseTag, pkg.version) > 0 ? baseTag.replace(/^v/, '') : pkg.version;
  const messages = git('log', '--format=%B%x00', ...(baseTag ? [`${baseTag}..HEAD`] : ['HEAD']))
    .split('\0')
    .map((message) => message.trim())
    .filter(Boolean);
  // A retry after the release tag was created repairs assets instead of incrementing again.
  const version =
    baseTag && !messages.length && compare(baseTag, pkg.version) >= 0
      ? baseTag.replace(/^v/, '')
      : nextVersion(current, messages);
  const notes =
    messages.map((message) => `- ${message.split('\n')[0]}`).join('\n') || `Release ${version}`;
  return {
    version,
    tag: `v${version}`,
    sha,
    notes,
    unchanged: Boolean(baseTag && !messages.length && compare(baseTag, pkg.version) >= 0),
  };
}

async function githubJson(route, token, request) {
  const response = await request(`https://api.github.com/repos/susanbeasles/star-config/${route}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Cannot inspect release completion: GitHub ${response.status}`);
  }
  return response.json();
}

async function verifyReleaseTag(plan, token, request) {
  if (!/^[a-f0-9]{40}$/.test(plan.sha ?? '')) {
    throw new Error('A verified source commit SHA is required');
  }
  let object = (await githubJson(`git/ref/tags/${encodeURIComponent(plan.tag)}`, token, request))
    ?.object;
  const visited = new Set();
  // Annotated tags can point at another tag; resolve only Git objects in this repo.
  while (object?.type === 'tag') {
    if (!/^[a-f0-9]{40}$/.test(object.sha) || visited.has(object.sha) || visited.size >= 8) {
      throw new Error('Invalid or excessive annotated release tag chain');
    }
    visited.add(object.sha);
    object = (await githubJson(`git/tags/${object.sha}`, token, request))?.object;
  }
  if (object?.type !== 'commit' || object.sha !== plan.sha) {
    throw new Error('Release tag does not match the verified source commit');
  }
}

export async function completedRelease(plan, token, request = fetch) {
  const release = await githubJson(`releases/tags/${encodeURIComponent(plan.tag)}`, token, request);
  if (!release) {
    return false;
  }
  await verifyReleaseTag(plan, token, request);
  const required = [
    'star-config-linux-x64.gz',
    'star-config-linux-arm64.gz',
    'star-config-darwin-arm64.gz',
    'star-config-darwin-x64.gz',
    'star-config-windows-x64.exe.gz',
    `susanbeasles-star-config-${plan.version}.tgz`,
    'SHA256SUMS',
    'install.sh',
  ];
  return (
    release.draft === false &&
    release.tag_name === plan.tag &&
    required.every((name) =>
      release.assets?.some(
        (asset) => asset.name === name && /^sha256:[a-f0-9]{64}$/.test(asset.digest),
      ),
    )
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = releasePlan();
  const release = !(
    plan.unchanged &&
    process.env.GH_TOKEN &&
    (await completedRelease(plan, process.env.GH_TOKEN))
  );
  writeFileSync('release-notes.md', `${plan.notes}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `release=${release}\n`);
    for (const key of ['version', 'tag', 'sha']) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${plan[key]}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}
