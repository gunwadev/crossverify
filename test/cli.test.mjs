import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'plugin', 'scripts', 'cli.mjs');
const STATUSLINE_PATH = path.join(__dirname, '..', 'plugin', 'scripts', 'statusline-segment.mjs');

function makeSandbox() {
  const home = mkdtempSync(path.join(tmpdir(), 'crossverify-home-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'crossverify-cwd-'));
  return { home, cwd };
}

function baseEnv(home, extraEnv) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CROSSVERIFY;
  delete env.CLAUDE_PLUGIN_DATA;
  Object.assign(env, extraEnv || {});
  return env;
}

function runCli(args, { home, cwd, extraEnv = {}, input } = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: baseEnv(home, extraEnv),
    encoding: 'utf8',
    input,
  });
}

function runStatusline({ home, cwd }) {
  return spawnSync(process.execPath, [STATUSLINE_PATH], {
    cwd,
    env: baseEnv(home),
    encoding: 'utf8',
  });
}

test('crossverify on writes enabled=1 to project conf', () => {
  const { home, cwd } = makeSandbox();
  const result = runCli(['on'], { home, cwd });
  assert.equal(result.status, 0);
  const confPath = path.join(cwd, '.claude', 'crossverify.conf');
  const text = readFileSync(confPath, 'utf8');
  assert.match(text, /^enabled=1$/m);
});

test('crossverify off writes enabled=0 to project conf', () => {
  const { home, cwd } = makeSandbox();
  runCli(['on'], { home, cwd });
  const result = runCli(['off'], { home, cwd });
  assert.equal(result.status, 0);
  const confPath = path.join(cwd, '.claude', 'crossverify.conf');
  const text = readFileSync(confPath, 'utf8');
  assert.match(text, /^enabled=0$/m);
});

test('crossverify pack <name> writes pack to project conf', () => {
  const { home, cwd } = makeSandbox();
  const result = runCli(['pack', 'security'], { home, cwd });
  assert.equal(result.status, 0);
  const confPath = path.join(cwd, '.claude', 'crossverify.conf');
  const text = readFileSync(confPath, 'utf8');
  assert.match(text, /^pack=security$/m);
  assert.match(result.stdout, /project pack=security written to/);
});

test('crossverify output global writes output=global to project conf', () => {
  const { home, cwd } = makeSandbox();
  const result = runCli(['output', 'global'], { home, cwd });
  assert.equal(result.status, 0);
  const confPath = path.join(cwd, '.claude', 'crossverify.conf');
  const text = readFileSync(confPath, 'utf8');
  assert.match(text, /^output=global$/m);
  assert.match(result.stdout, /project output=global written to/);
});

test('crossverify global on writes enabled=1 to global conf', () => {
  const { home, cwd } = makeSandbox();
  const result = runCli(['global', 'on'], { home, cwd });
  assert.equal(result.status, 0);
  const confPath = path.join(home, '.claude', 'crossverify', 'config');
  const text = readFileSync(confPath, 'utf8');
  assert.match(text, /^enabled=1$/m);
});

test('crossverify lock on writes lock=1 to global conf only', () => {
  const { home, cwd } = makeSandbox();
  const result = runCli(['lock', 'on'], { home, cwd });
  assert.equal(result.status, 0);
  const globalConf = path.join(home, '.claude', 'crossverify', 'config');
  const text = readFileSync(globalConf, 'utf8');
  assert.match(text, /^lock=1$/m);
  const projectConf = path.join(cwd, '.claude', 'crossverify.conf');
  assert.equal(existsSync(projectConf), false);
});

test('status --json reports env precedence and decidedBy', () => {
  const { home, cwd } = makeSandbox();
  runCli(['global', 'on'], { home, cwd });
  const result = runCli(['status', '--json'], {
    home,
    cwd,
    extraEnv: { CROSSVERIFY: 'foreground' },
  });
  assert.equal(result.status, 0);
  const config = JSON.parse(result.stdout);
  assert.equal(config.enabled, true);
  assert.equal(config.mode, 'foreground');
  assert.equal(config.decidedBy.enabled, 'env');
  assert.equal(config.decidedBy.mode, 'env');
});

test('status reports lock violation line when project disable is overridden', () => {
  const { home, cwd } = makeSandbox();
  runCli(['lock', 'on'], { home, cwd });
  runCli(['global', 'on'], { home, cwd });
  runCli(['off'], { home, cwd });
  const result = runCli(['status'], { home, cwd });
  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /enabled=0 ignored: locked by global config \(lock=1\)\. Only the user can unlock: crossverify lock off/
  );
});

test('off then status prints no lock-violation line when nothing is locked', () => {
  const { home, cwd } = makeSandbox();
  const offResult = runCli(['off'], { home, cwd });
  assert.equal(offResult.status, 0);
  assert.doesNotMatch(offResult.stdout, /LOCK_VIOLATION|ignored: locked/);
  const statusResult = runCli(['status'], { home, cwd });
  assert.equal(statusResult.status, 0);
  assert.doesNotMatch(statusResult.stdout, /ignored: locked/);
  assert.doesNotMatch(
    statusResult.stdout,
    /Only the user can unlock: crossverify lock off/
  );
});

test('unknown subcommand prints usage to stdout and exits 1', () => {
  const { home, cwd } = makeSandbox();
  const result = runCli(['bogus'], { home, cwd });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /crossverify status/);
});

test('help subcommand prints usage and exits 0', () => {
  const { home, cwd } = makeSandbox();
  const result = runCli(['help'], { home, cwd });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test('uninstall --yes removes global config and state without prompting', () => {
  const { home, cwd } = makeSandbox();
  runCli(['global', 'on'], { home, cwd });
  const globalConf = path.join(home, '.claude', 'crossverify', 'config');
  assert.equal(existsSync(globalConf), true);
  const settingsDir = path.join(home, '.claude');
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({ hooks: { Stop: [] } }, null, 2)
  );
  const result = runCli(['uninstall', '--yes'], { home, cwd });
  assert.equal(result.status, 0);
  assert.equal(existsSync(globalConf), false);
});

test('uninstall with closed stdin aborts cleanly instead of hanging, exits 1', () => {
  const { home, cwd } = makeSandbox();
  runCli(['global', 'on'], { home, cwd });
  const globalConf = path.join(home, '.claude', 'crossverify', 'config');
  // No `input` means spawnSync closes stdin immediately (EOF) — same as a
  // piped/non-interactive invocation with nothing to send.
  const result = runCli(['uninstall'], { home, cwd, input: '' });
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /Aborted\. Nothing was removed\. \(use --yes non-interactively\)/
  );
  assert.equal(existsSync(globalConf), true, 'nothing was actually removed');
});

test('uninstall decline (n) aborts cleanly, exit 0, config/state left in place', () => {
  const { home, cwd } = makeSandbox();
  runCli(['global', 'on'], { home, cwd });
  const globalConf = path.join(home, '.claude', 'crossverify', 'config');
  assert.equal(existsSync(globalConf), true);
  const settingsDir = path.join(home, '.claude');
  mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [] } }, null, 2));
  const result = runCli(['uninstall'], { home, cwd, input: 'n\n' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Aborted\. Nothing was removed\./);
  assert.equal(existsSync(globalConf), true, 'declining must leave global config in place');
  assert.equal(existsSync(settingsPath), true, 'declining must leave settings.json in place');
});

test('crossverify report shows the newest report summary', () => {
  const { home, cwd } = makeSandbox();
  const reportsDir = path.join(cwd, '.crossverify');
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(
    path.join(reportsDir, 'sess1-2026-07-20T10-00-00.json'),
    JSON.stringify({ status: 'verified', claims_failed: 0 }, null, 2) + '\n'
  );
  const result = runCli(['report'], { home, cwd });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /crossverify · VERIFIED/);
  assert.match(result.stdout, /0 verified · 0 failed · 0 unverified/);
  assert.match(result.stdout, /■ PASS — all claims verified/);
});

test('crossverify report --json prints the raw verdict JSON', () => {
  const { home, cwd } = makeSandbox();
  const reportsDir = path.join(cwd, '.crossverify');
  mkdirSync(reportsDir, { recursive: true });
  const verdict = { status: 'failed', claims_failed: 2 };
  writeFileSync(
    path.join(reportsDir, 'sess1-2026-07-20T10-01-00.json'),
    JSON.stringify(verdict, null, 2) + '\n'
  );
  const result = runCli(['report', '--json'], { home, cwd });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), verdict);
});

test('crossverify report with corrupt JSON prints a clear message and exits 0', () => {
  const { home, cwd } = makeSandbox();
  const reportsDir = path.join(cwd, '.crossverify');
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, 'sess1-2026-07-20T10-02-00.json');
  writeFileSync(reportPath, '{not valid json');
  const result = runCli(['report'], { home, cwd });
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`Latest report is not valid JSON: .*${'sess1-2026-07-20T10-02-00.json'}`));
});

test('crossverify report with no reports prints a helpful message', () => {
  const { home, cwd } = makeSandbox();
  const result = runCli(['report'], { home, cwd });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No verifier reports found/);
});

test('statusline segment prints nothing when no reports exist', () => {
  const { home, cwd } = makeSandbox();
  const result = runStatusline({ home, cwd });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('statusline segment prints verified marker for a verified report', () => {
  const { home, cwd } = makeSandbox();
  const reportsDir = path.join(cwd, '.crossverify');
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(
    path.join(reportsDir, '2026-07-20T10-00-00.json'),
    JSON.stringify({ status: 'verified', claims_failed: 0 })
  );
  const result = runStatusline({ home, cwd });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '[VFY ✓]');
});

test('statusline segment prints failed marker with claim count', () => {
  const { home, cwd } = makeSandbox();
  const reportsDir = path.join(cwd, '.crossverify');
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(
    path.join(reportsDir, '2026-07-20T10-05-00.json'),
    JSON.stringify({ status: 'failed', claims_failed: 3 })
  );
  const result = runStatusline({ home, cwd });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '[VFY ✗ fix:3]');
});

test('statusline segment falls back to counting failed claims when claims_failed is absent', () => {
  const { home, cwd } = makeSandbox();
  const reportsDir = path.join(cwd, '.crossverify');
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(
    path.join(reportsDir, '2026-07-20T10-06-00.json'),
    JSON.stringify({
      status: 'failed',
      claims: [{ status: 'failed' }, { status: 'passed' }, { status: 'failed' }],
    })
  );
  const result = runStatusline({ home, cwd });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '[VFY ✗ fix:2]');
});

test('statusline segment shows running marker for a fresh .running fixture', () => {
  const { home, cwd } = makeSandbox();
  const reportsDir = path.join(cwd, '.crossverify');
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(path.join(reportsDir, 'sess1-2026-07-20T10-07-00.running'), '');
  const result = runStatusline({ home, cwd });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '[VFY …]');
});

test('statusline segment ignores a stale .running marker and deletes it', () => {
  const { home, cwd } = makeSandbox();
  const reportsDir = path.join(cwd, '.crossverify');
  mkdirSync(reportsDir, { recursive: true });
  const stalePath = path.join(reportsDir, 'sess1-2026-07-20T10-07-00.running');
  writeFileSync(stalePath, '');
  const staleTime = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
  utimesSync(stalePath, staleTime, staleTime);
  const result = runStatusline({ home, cwd });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(stalePath), false);
});

test('statusline segment never crashes the process on a corrupt report', () => {
  const { home, cwd } = makeSandbox();
  const reportsDir = path.join(cwd, '.crossverify');
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(path.join(reportsDir, '2026-07-20T10-08-00.json'), '{not valid json');
  const result = runStatusline({ home, cwd });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test("output=global: report only surfaces THIS project's reports (projectKey filter)", async () => {
  const { home, cwd } = makeSandbox();
  const otherProj = mkdtempSync(path.join(tmpdir(), 'crossverify-other-'));
  const { projectKey } = await import('../plugin/scripts/lib/config.mjs');
  const globalReports = path.join(home, '.claude', 'crossverify', 'reports');
  mkdirSync(globalReports, { recursive: true });
  mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  writeFileSync(path.join(cwd, '.claude', 'crossverify.conf'), 'output=global\n');
  writeFileSync(
    path.join(globalReports, `${projectKey(cwd)}-sessA-1.json`),
    JSON.stringify({ status: 'verified', claims_failed: 0 })
  );
  // Other project's report is NEWER — without the filter it wins on mtime.
  const other = path.join(globalReports, `${projectKey(otherProj)}-sessB-2.json`);
  writeFileSync(other, JSON.stringify({ status: 'failed', claims_failed: 9 }));
  const future = (Date.now() + 60_000) / 1000;
  utimesSync(other, future, future);
  const res = runCli(['report', '--json'], { home, cwd });
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).status, 'verified',
    "must return this project's report, not the newer foreign one");
});

test('crossverify research on/off writes project conf; junk arg exits 1', () => {
  const { home, cwd } = makeSandbox();
  let res = runCli(['research', 'on'], { home, cwd });
  assert.equal(res.status, 0);
  assert.match(readFileSync(path.join(cwd, '.claude', 'crossverify.conf'), 'utf8'), /research=on/);
  res = runCli(['research', 'off'], { home, cwd });
  assert.equal(res.status, 0);
  assert.match(readFileSync(path.join(cwd, '.claude', 'crossverify.conf'), 'utf8'), /research=off/);
  res = runCli(['research', 'sideways'], { home, cwd });
  assert.equal(res.status, 1);
});
