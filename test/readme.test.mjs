import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('preserves the real-usage data points', () => {
  // Refreshed 2026-07-22 from a live recount of ~/.claude/verifier-reports
  // (checklist final-gate rule: recount at publish time, never trust a stale
  // snapshot).
  assert.match(readme, /\*\*817\*\* across \*\*114 distinct sessions\*\*/);
  assert.match(readme, /\*\*4,777\*\*/);
  assert.match(readme, /~25%/);
  assert.match(readme, /\*\*276\*\* of 4,777/);
});

test('preserves the architecture diagram', () => {
  assert.match(readme, /Stop hook fires \(Claude Code\)/);
  assert.match(readme, /--sandbox read-only/);
});

test('install section: marketplace first, clone second, npx marked coming soon', () => {
  assert.match(readme, /\/plugin marketplace add/);
  assert.match(readme, /\/plugin install crossverify/);
  assert.match(readme, /\/crossverify:setup/);
  assert.match(readme, /node install\.mjs/);
  assert.match(readme, /npx crossverify init/);
  assert.match(readme, /coming soon/i);
  const mkt = readme.indexOf('/plugin marketplace add');
  const clone = readme.indexOf('git clone');
  const npx = readme.indexOf('npx crossverify init');
  assert.ok(mkt !== -1 && clone !== -1 && npx !== -1, 'all three install paths present');
  assert.ok(mkt < clone && clone < npx, 'install paths appear in promotion order');
});

test('what-this-touches / how-to-undo section exists with the undo guarantees', () => {
  // Position note: deliberately AFTER the pitch sections since the README
  // restyle (bat/uv blueprint) — trust plumbing lives between Compare and
  // Security. The guarantees themselves are the pinned contract.
  assert.match(readme, /## What this touches, and how to undo it/);
  assert.match(readme, /crossverify uninstall/);
  assert.match(readme, /\.bak/);
  assert.match(readme, /Default off/);
});

test('config reference: all 9 keys, precedence chain, env vars', () => {
  for (const key of ['enabled', 'mode', 'output', 'pack', 'research', 'second', 'gaps', 'lock', 'failmode']) {
    assert.match(readme, new RegExp('`' + key + '`'), `key ${key} documented`);
  }
  assert.match(readme, /env > project conf > global conf > default/);
  assert.match(readme, /CROSSVERIFY/);
  assert.match(readme, /CROSSVERIFY_MODEL/);
  assert.match(readme, /CROSSVERIFY_SECOND_MODEL/);
  assert.match(readme, /CROSSVERIFY_SECOND=1/);
  assert.match(readme, /### Second reviewer/);
  assert.match(readme, /### Gap analysis/);
});

test('tamper lock and fail-open are explained', () => {
  assert.match(readme, /lock=1/);
  assert.match(readme, /fail[- ]open/i);
  assert.match(readme, /failmode=closed/);
});

test('security section states the supply-chain posture', () => {
  assert.match(readme, /[Zz]ero runtime dependencies/);
  assert.match(readme, /lifecycle scripts/);
  assert.match(readme, /[Nn]o build step/);
  assert.match(readme, /provenance/);
});

test('positioning: turn boundary vs PR boundary, honest codex-plugin-cc comparison', () => {
  assert.match(readme, /turn boundary/i);
  assert.match(readme, /PR boundary/i);
  assert.match(readme, /codex-plugin-cc/);
});

test('no hype language (PUBLISH-CHECKLIST rule)', () => {
  assert.doesNotMatch(readme, /revolutionary|game.chang|\b10x\b/i);
});

test('no machine-specific absolute paths in the README', () => {
  assert.doesNotMatch(readme, /\/Users\/|\/home\//);
});
