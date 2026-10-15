// @ts-check
/**
 * Stack detection. Pure function of the repo's file list plus a few manifest reads,
 * so it is cheap and testable. Everything else (lint steps, tests, scaffolding,
 * dependabot ecosystems, devcontainer features) is derived from this result.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} NodeStack
 * @property {'npm' | 'pnpm' | 'yarn' | 'bun'} pm
 * @property {boolean} typescript
 * @property {boolean} react
 * @property {boolean} reactNative
 * @property {boolean} web          A browser app (React DOM / Vite / Next) → Playwright.
 * @property {boolean} cdk          AWS CDK app → cdk-nag.
 * @property {boolean} hasBuild     package.json already defines a build script.
 * @property {'eslint' | 'biome'} lintProfile
 *
 * @typedef {object} Stacks
 * @property {NodeStack | null} node
 * @property {{ manager: 'uv' | 'poetry' | 'pip', hasPyproject: boolean } | null} python
 * @property {boolean} rust
 * @property {{ spm: boolean, xcode: boolean } | null} swift
 * @property {boolean} shell
 * @property {boolean} yaml
 * @property {boolean} githubActions
 * @property {boolean} circleci
 * @property {{ files: string[] } | null} docker
 * @property {{ files: string[] } | null} cloudflare   wrangler.toml / wrangler.json(c)
 * @property {boolean} terraform
 * @property {boolean} devcontainer
 */

const base = (/** @type {string} */ f) => f.slice(f.lastIndexOf('/') + 1);
const ext = (/** @type {string} */ f) => {
  const b = base(f);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
};

export const DOCKERFILE_RE = /^(Dockerfile|Containerfile)(\..+)?$|\.(dockerfile|containerfile)$/i;

/**
 * @param {string} root
 * @param {string} rel
 */
function readJson(root, rel) {
  try {
    return JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} root
 * @param {string[]} files
 * @returns {NodeStack | null}
 */
function detectNode(root, files) {
  if (!files.includes('package.json') && !existsSync(path.join(root, 'package.json'))) {
    return null;
  }
  const pkg = readJson(root, 'package.json') ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  const has = (/** @type {string} */ name) => Object.hasOwn(deps, name);
  const lock = (/** @type {string} */ name) =>
    files.includes(name) || existsSync(path.join(root, name));
  /** @type {NodeStack['pm']} */
  let pm = 'npm';
  if (lock('pnpm-lock.yaml')) {
    pm = 'pnpm';
  } else if (lock('yarn.lock')) {
    pm = 'yarn';
  } else if (lock('bun.lock') || lock('bun.lockb')) {
    pm = 'bun';
  }
  const reactNative = has('react-native') || has('expo');
  const biomeConfigured = lock('biome.json') || lock('biome.jsonc');
  const eslintConfigured = files.some(
    (f) => /^eslint\.config\.[cm]?[jt]s$/.test(f) || /^\.eslintrc/.test(f),
  );
  return {
    pm,
    typescript: has('typescript') || files.some((f) => /\.(ts|tsx|mts|cts)$/.test(f)),
    react: has('react'),
    reactNative,
    web:
      !reactNative && (has('react-dom') || has('vite') || has('next') || has('@playwright/test')),
    cdk: has('aws-cdk-lib') || lock('cdk.json'),
    hasBuild: Boolean(pkg.scripts?.build),
    lintProfile: biomeConfigured && !eslintConfigured ? 'biome' : 'eslint',
  };
}

/**
 * @param {string[]} files
 */
function detectPython(files) {
  const hasPyproject = files.includes('pyproject.toml');
  const any =
    hasPyproject ||
    files.includes('requirements.txt') ||
    files.includes('setup.py') ||
    files.some((f) => ext(f) === 'py');
  if (!any) {
    return null;
  }
  /** @type {'uv' | 'poetry' | 'pip'} */
  let manager = 'uv';
  if (files.includes('poetry.lock')) {
    manager = 'poetry';
  } else if (!hasPyproject && files.includes('requirements.txt') && !files.includes('uv.lock')) {
    manager = 'pip';
  }
  return { manager, hasPyproject };
}

/**
 * @param {string} root  repo root (absolute)
 * @param {string[]} files  repo-relative POSIX paths
 * @returns {Stacks}
 */
export function detectStacks(root, files) {
  const dockerFiles = files.filter((f) => DOCKERFILE_RE.test(base(f)));
  const wrangler = files.filter((f) => /^wrangler\.(toml|json|jsonc)$/.test(base(f)));
  const spm = files.some((f) => base(f) === 'Package.swift');
  const xcode = files.some((f) => /\.xcodeproj\//.test(f) || /\.xcworkspace\//.test(f));
  const swiftFiles = files.some((f) => ext(f) === 'swift');
  return {
    node: detectNode(root, files),
    python: detectPython(files),
    rust: files.some((f) => base(f) === 'Cargo.toml'),
    swift: spm || xcode || swiftFiles ? { spm, xcode } : null,
    shell: files.some((f) => ['sh', 'bash', 'bats'].includes(ext(f))),
    yaml: files.some((f) => ['yml', 'yaml'].includes(ext(f))),
    githubActions: files.some((f) => f.startsWith('.github/workflows/')),
    circleci: files.some((f) => f.startsWith('.circleci/')),
    docker: dockerFiles.length ? { files: dockerFiles } : null,
    cloudflare: wrangler.length ? { files: wrangler } : null,
    terraform: files.some((f) => ext(f) === 'tf'),
    devcontainer: files.some((f) => f.startsWith('.devcontainer/')),
  };
}

/**
 * One-line human summary, used by doctor/setup output and AGENTS.md.
 * @param {Stacks} s
 */
export function describeStacks(s) {
  /** @type {Array<[unknown, string | (() => string)]>} */
  const table = [
    [s.node, () => nodeLabel(/** @type {NodeStack} */ (s.node))],
    [s.python, () => `Python (${s.python?.manager})`],
    [s.rust, 'Rust'],
    [s.swift, () => swiftLabel(/** @type {{ spm: boolean, xcode: boolean }} */ (s.swift))],
    [s.shell, 'Shell'],
    [s.docker, 'Docker'],
    [s.cloudflare, 'Cloudflare Workers'],
    [s.terraform, 'Terraform'],
    [s.githubActions, 'GitHub Actions'],
    [s.circleci, 'CircleCI'],
  ];
  return table
    .filter(([present]) => present)
    .map(([, label]) => (typeof label === 'function' ? label() : label));
}

/** @param {NodeStack} n */
function nodeLabel(n) {
  const flavors = [
    n.typescript && 'TypeScript',
    n.reactNative && 'React Native',
    n.react && !n.reactNative && 'React',
    n.cdk && 'AWS CDK',
  ].filter(Boolean);
  return flavors.length ? `Node (${n.pm}, ${flavors.join(', ')})` : `Node (${n.pm})`;
}

/** @param {{ spm: boolean, xcode: boolean }} sw */
function swiftLabel(sw) {
  const kinds = [sw.spm && 'SwiftPM', sw.xcode && 'Xcode'].filter(Boolean).join(', ');
  return `Swift (${kinds || 'sources'})`;
}
