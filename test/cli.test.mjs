import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as fakeCodex from './helpers/fake-codex.mjs';
const awaitImport = () => fakeCodex;
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

test('crossverify second on/off and gaps on/off write project conf; junk exits 1', () => {
  const { home, cwd } = makeSandbox();
  let res = runCli(['second', 'on'], { home, cwd });
  assert.equal(res.status, 0);
  assert.match(readFileSync(path.join(cwd, '.claude', 'crossverify.conf'), 'utf8'), /^second=on$/m);
  res = runCli(['second', 'off'], { home, cwd });
  assert.equal(res.status, 0);
  res = runCli(['gaps', 'off'], { home, cwd });
  assert.equal(res.status, 0);
  assert.match(readFileSync(path.join(cwd, '.claude', 'crossverify.conf'), 'utf8'), /^gaps=off$/m);
  assert.equal(runCli(['second', 'sideways'], { home, cwd }).status, 1);
  assert.equal(runCli(['gaps', 'sideways'], { home, cwd }).status, 1);
});

test('status table lists second and gaps', () => {
  const { home, cwd } = makeSandbox();
  const res = runCli(['status'], { home, cwd });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^second +off +default$/m);
  assert.match(res.stdout, /^gaps +on +default$/m);
});

test('second setup without fireconnect prints the install pointer and exits 1, writes nothing', () => {
  const { home, cwd } = makeSandbox();
  const res = runCli(['second', 'setup'], { home, cwd, extraEnv: { PATH: path.dirname(process.execPath) } });
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /fireconnect not found/);
  assert.equal(existsSync(path.join(home, '.claude', 'crossverify', 'codex-home-second')), false);
});

test('second setup with a fake fireconnect writes the second codex home and enables second=on', () => {
  const { home, cwd } = makeSandbox();
  const bin = mkdtempSync(path.join(tmpdir(), 'cv-fakefc-'));
  // Fake fireconnect: records argv, writes a config.toml at --config-path.
  writeFileSync(path.join(bin, 'fireconnect'), [
    '#!/usr/bin/env node',
    "const fs=require('node:fs');const a=process.argv.slice(2);",
    "fs.writeFileSync(process.env.FC_ARGS_OUT, JSON.stringify(a));",
    "const i=a.indexOf('--config-path');",
    "fs.writeFileSync(a[i+1], 'model_provider = \"fireworks-ai\"\\nmodel = \"firerouter\"\\n');",
  ].join('\n'), { mode: 0o755 });
  const argsOut = path.join(bin, 'args.json');
  const res = runCli(['second', 'setup'], {
    home, cwd,
    extraEnv: { PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), FC_ARGS_OUT: argsOut },
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const secondHome = path.join(home, '.claude', 'crossverify', 'codex-home-second');
  assert.match(readFileSync(path.join(secondHome, 'config.toml'), 'utf8'), /firerouter/);
  const args = JSON.parse(readFileSync(argsOut, 'utf8'));
  assert.deepEqual(args.slice(0, 2), ['codex', 'on']);
  assert.ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'firerouter');
  assert.equal(args[args.indexOf('--config-path') + 1], path.join(secondHome, 'config.toml'));
  // Our config lives outside ~/.codex, so the ChatGPT-app-running guard (which protects the shared config) does not apply.
  assert.ok(args.includes('--force'));
  assert.match(readFileSync(path.join(cwd, '.claude', 'crossverify.conf'), 'utf8'), /^second=on$/m);
  assert.match(res.stdout, /second reviewer ready/);
});

test('crossverify report renders gaps and the second reviewer line', () => {
  const { home, cwd } = makeSandbox();
  const reportsDir = path.join(cwd, '.crossverify');
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(path.join(reportsDir, 'sess1-x.json'), JSON.stringify({
    status: 'verified', claims_failed: 0, verified: [{ claim: 'a', evidence: 'ok' }],
    gaps: [{ gap: 'no retry', classification: 'CONFIRMED', evidence: 'x.mjs:3', fix: 'add retry' }],
    second: { model: 'firerouter', status: 'verified', agreed: true },
  }));
  const res = runCli(['report'], { home, cwd });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /! CONFIRMED no retry/);
  assert.match(res.stdout, /└ x\.mjs:3 · fix: add retry/);
  assert.match(res.stdout, /second reviewer firerouter: verified \(agrees\)/);
  assert.match(res.stdout, /1 gap/);
});

test('second now --transcript runs the verifier on demand and prints the report', () => {
  const { home, cwd } = makeSandbox();
  mkdirSync(path.join(cwd, '.git'));
  const bin = mkdtempSync(path.join(tmpdir(), 'cv-fake-codex-'));
  const secondHome = path.join(home, '.claude', 'crossverify', 'codex-home-second');
  mkdirSync(secondHome, { recursive: true });
  writeFileSync(path.join(secondHome, 'config.toml'), 'model = "firerouter"\n');
  writeFileSync(path.join(bin, 'verdict.json'), JSON.stringify({
    status: 'verified', confidence: 'VERIFIED', claims_total: 1, claims_verified: 1, claims_failed: 0, claims_unverified: 0,
    verified: [{ claim: 'x', evidence: 'y' }], failed: [], could_not_verify: [], external_claims: [], feedback: '', needs_from_user: '',
    gaps: [{ gap: 'g', classification: 'CONFIRMED', evidence: 'e', fix: 'f' }],
  }));
  // Same verdict for both homes is fine here: the point is that the second line appears.
  const { installFakeCodex, fakePathEntries } = awaitImport();
  installFakeCodex(bin);
  const transcript = path.join(bin, 't.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'q' } }) + '\n'
    + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } }) + '\n');
  const res = runCli(['second', 'now', '--transcript', transcript], {
    home, cwd,
    extraEnv: { PATH: fakePathEntries(bin).join(path.delimiter), FAKE_VERDICT_FILE: path.join(bin, 'verdict.json'), CROSSVERIFY: '1' },
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /crossverify · VERIFIED/);
  assert.match(res.stdout, /second reviewer firerouter: verified \(agrees\)/);
  assert.match(res.stdout, /! CONFIRMED g/);
});

test('second now without a second codex home explains setup and exits 1', () => {
  const { home, cwd } = makeSandbox();
  const res = runCli(['second', 'now', '--transcript', path.join(cwd, 'nope.jsonl')], { home, cwd });
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /crossverify second setup/);
});

test('second now with no transcript found explains where it looked and exits 1', () => {
  const { home, cwd } = makeSandbox();
  const secondHome = path.join(home, '.claude', 'crossverify', 'codex-home-second');
  mkdirSync(secondHome, { recursive: true });
  writeFileSync(path.join(secondHome, 'config.toml'), 'model = "firerouter"\n');
  const res = runCli(['second', 'now'], { home, cwd });
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /no transcript found/i);
  assert.match(res.stdout + res.stderr, /\.claude[\\/]projects/);
});

// ---- crossverify second check: is Fireworks actually usable right now? ----
import { createServer } from 'node:http';

function withFireworksMock(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', async () => {
      try { resolve(await fn(`http://127.0.0.1:${server.address().port}/inference/v1`)); }
      catch (e) { reject(e); }
      finally { server.close(); }
    });
  });
}

// spawnSync would block the event loop the mock server lives on, so the CLI
// could never get an answer; run it async for these tests.
import { spawn } from 'node:child_process';
function runCliAsync(args, { home, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd, env: baseEnv(home), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function secondHomeWith(home, baseUrl, model = 'firerouter') {
  const dir = path.join(home, '.claude', 'crossverify', 'codex-home-second');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.toml'), [
    'model_provider = "fireworks-ai"', `model = "${model}"`, '',
    '[model_providers.fireworks-ai]', 'name = "Fireworks"', `base_url = "${baseUrl}"`,
    'wire_api = "responses"', 'experimental_bearer_token = "fw_testkey_000000000000"', '',
  ].join('\n'));
}

test('second check: 200 reports OK with the served model and exits 0', async () => {
  const { home, cwd } = makeSandbox();
  let seen = null;
  await withFireworksMock((req, res, body) => {
    seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'glm-5p3-flash', choices: [{ message: { content: 'ok' } }] }));
  }, async (base) => {
    secondHomeWith(home, base);
    const res = await runCliAsync(['second', 'check'], { home, cwd });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Fireworks: OK/);
    assert.match(res.stdout, /firerouter.*served by glm-5p3-flash/);
    assert.equal(seen.url, '/inference/v1/chat/completions');
    assert.equal(seen.auth, 'Bearer fw_testkey_000000000000');
    assert.equal(seen.body.max_tokens, 1);
    assert.doesNotMatch(res.stdout, /fw_testkey/, 'never print the key');
  });
});

test('second check: 412 reports account suspended with the billing link, exits 2', async () => {
  const { home, cwd } = makeSandbox();
  await withFireworksMock((req, res) => {
    res.writeHead(412, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Account x is suspended, possibly due to reaching the monthly spending limit. Please go to https://fireworks.ai/account/billing' } }));
  }, async (base) => {
    secondHomeWith(home, base);
    const res = await runCliAsync(['second', 'check'], { home, cwd });
    assert.equal(res.status, 2);
    assert.match(res.stdout, /Fireworks: SUSPENDED/);
    assert.match(res.stdout, /fireworks\.ai\/account\/billing/);
  });
});

test('second check: 429 reports rate limited with retry-after, exits 2', async () => {
  const { home, cwd } = makeSandbox();
  await withFireworksMock((req, res) => {
    res.writeHead(429, { 'retry-after': '56' });
    res.end('{"error":{"message":"rate limit"}}');
  }, async (base) => {
    secondHomeWith(home, base);
    const res = await runCliAsync(['second', 'check'], { home, cwd });
    assert.equal(res.status, 2);
    assert.match(res.stdout, /Fireworks: RATE LIMITED/);
    assert.match(res.stdout, /retry in 56s/);
  });
});

test('second check: 401 reports bad key, exits 2; no setup reports not configured, exits 1', async () => {
  const { home, cwd } = makeSandbox();
  const none = runCli(['second', 'check'], { home, cwd });
  assert.equal(none.status, 1);
  assert.match(none.stdout + none.stderr, /not configured.*crossverify second setup/);
  await withFireworksMock((req, res) => { res.writeHead(401); res.end(''); }, async (base) => {
    secondHomeWith(home, base);
    const res = await runCliAsync(['second', 'check'], { home, cwd });
    assert.equal(res.status, 2);
    assert.match(res.stdout, /Fireworks: KEY REJECTED/);
    assert.match(res.stdout, /fireconnect login/);
  });
});
