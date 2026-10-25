import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../src/assets.js';
import { getLanguage } from '../src/languages.js';
import { resolveTool } from '../src/runner.js';
import { makeRepo, out } from './helpers.js';

const available = getLanguage('swift').steps.every((step) => resolveTool(step, PACKAGE_ROOT));
let repo;
afterEach(() => repo?.cleanup());
it.runIf(available)('keeps swift-format and SwiftLint consistent for multiline collections', () => {
  repo = makeRepo();
  repo.put('Calculator.swift', 'public let values:[Int] = [\n1,\n2\n]\n');
  const formatted = repo.cli(['format']);
  expect(formatted.status, out(formatted)).toBe(0);
  const first = readFileSync(path.join(repo.root, 'Calculator.swift'), 'utf8');
  const checked = repo.cli(['run', 'swift', '--check', 'Calculator.swift']);
  expect(checked.status, out(checked)).toBe(0);
  expect(repo.cli(['format']).status).toBe(0);
  expect(readFileSync(path.join(repo.root, 'Calculator.swift'), 'utf8')).toBe(first);
});
