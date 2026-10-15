import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeWrangler, stripJsonc } from '../src/wrangler-nag.js';

const NOW = new Date('2026-10-14');
let dir;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});
const file = (name, content) => {
  dir = mkdtempSync(path.join(tmpdir(), 'wr-'));
  writeFileSync(path.join(dir, name), content);
  return path.join(dir, name);
};
const ids = (findings) => findings.map((f) => `${f.scope}:${f.id}`).sort();

describe('stripJsonc', () => {
  it('removes comments and trailing commas but never touches strings', () => {
    const src = '{\n // c\n "url": "https://x/*y*/", /* b */ "a": [1, 2,],\n "q": "\\"//",\n}';
    expect(JSON.parse(stripJsonc(src))).toEqual({ url: 'https://x/*y*/', a: [1, 2], q: '"//' });
  });
});

describe('wrangler-nag', () => {
  it('passes a hardened config', () => {
    const f = file(
      'wrangler.toml',
      `name = "api"\ncompatibility_date = "2026-09-01"\nworkers_dev = false\npreview_urls = false\nroutes = [{ pattern = "api.example.com/*", zone_name = "example.com" }]\n[observability]\nenabled = true\n`,
    );
    expect(analyzeWrangler(f, NOW)).toEqual([]);
  });

  it('flags plaintext secrets, workers.dev exposure, missing date and observability', () => {
    const f = file(
      'wrangler.jsonc',
      `{
        // prod worker
        "name": "api",
        "routes": [{ "pattern": "api.example.com/*", "zone_name": "example.com" }],
        "vars": { "API_KEY": "sk_live_123", "REGION": "us" },
      }`,
    );
    expect(ids(analyzeWrangler(f, NOW))).toEqual([
      'top-level:WR001',
      'top-level:WR002',
      'top-level:WR003',
      'top-level:WR004',
      'top-level:WR005',
    ]);
  });

  it('checks every env block and stale compatibility dates', () => {
    const f = file(
      'wrangler.toml',
      `name = "w"\ncompatibility_date = "2024-01-01"\n[observability]\nenabled = true\n[env.staging.vars]\nDB_PASSWORD = "hunter2"\n`,
    );
    expect(ids(analyzeWrangler(f, NOW))).toEqual([
      'env.staging:WR002',
      'env.staging:WR008',
      'top-level:WR008',
    ]);
  });
});
