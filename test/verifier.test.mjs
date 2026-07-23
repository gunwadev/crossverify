// test/verifier.test.mjs — Stop-hook entry: block-message template + gate order,
// tested by spawning verifier.mjs with piped stdin JSON inside a temp sandbox
// (temp HOME, fixture transcripts, fake `codex` on PATH).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { formatBlockMessage, MAX_ATTEMPTS } from '../plugin/scripts/verifier.mjs';
import { installFakeCodex, fakePathEntries } from './helpers/fake-codex.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFIER = path.join(REPO_ROOT, 'plugin', 'scripts', 'verifier.mjs');

// Fake codex CLI (Task 3 PATH trick): answers --version; on `codex exec` it
// copies $FAKE_VERDICT_FILE to the --output-last-message target and exits
// $FAKE_CODEX_EXIT (default 0). Cross-platform via helpers/fake-codex.mjs
// (env mode).

const MUTATION_TRANSCRIPT = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'please write the file' } }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a.txt', content: 'hi' } }] },
  }),
].join('\n') + '\n';

const NO_MUTATION_TRANSCRIPT = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'what does this file do?' } }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'It parses config lines.' }] },
  }),
].join('\n') + '\n';

const FAILED_VERDICT = {
  status: 'failed',
  confidence: 'FEEDBACK',
  claims_total: 1,
  claims_verified: 0,
  claims_failed: 1,
  claims_unverified: 0,
  verified: [],
  failed: [{ claim: 'created a.txt with content hi', evidence: 'a.txt missing on disk' }],
  could_not_verify: [],
  feedback: 'a.txt:1 — rule R1 file-exists: builder claimed to create a.txt but it does not exist. Create the file.',
  needs_from_user: '',
};

const VERIFIED_VERDICT = {
  status: 'verified',
  confidence: 'PERFECT',
  claims_total: 1,
  claims_verified: 1,
  claims_failed: 0,
  claims_unverified: 0,
  verified: [{ claim: 'created a.txt with content hi', evidence: 'a.txt present with expected content' }],
  failed: [],
  could_not_verify: [],
  feedback: '',
  needs_from_user: '',
};

// `CLAUDE_PLUGIN_DATA` is no longer consulted (v1 decision, see lib/config.mjs
// stateDir): state always resolves to `<HOME>/.claude/crossverify`, so the
// sandbox derives `state` from `home` rather than pointing at a separate dir.
function makeSandbox(t, { transcript = MUTATION_TRANSCRIPT, verdict = VERIFIED_VERDICT, rawVerdictText, withCodex = true, gitRepo = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crossverify-hook-'));
  // maxRetries: a detached background child may still be deleting its own
  // staged files while this rm walks the tree (transient ENOTEMPTY race).
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  for (const d of [home, cwd, bin]) fs.mkdirSync(d, { recursive: true });
  const state = path.join(home, '.claude', 'crossverify');
  fs.mkdirSync(state, { recursive: true });
  if (gitRepo) fs.mkdirSync(path.join(cwd, '.git'));
  const transcriptPath = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, transcript);
  const verdictFile = path.join(root, 'verdict.json');
  fs.writeFileSync(verdictFile, rawVerdictText !== undefined ? rawVerdictText : JSON.stringify(verdict));
  if (withCodex) installFakeCodex(bin); // env mode: reads FAKE_VERDICT_FILE
  // PATH: fake-codex bin (when enabled) + minimal node/system dirs — the real
  // codex install location can never leak in.
  const tmpDir = path.join(root, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const env = {
    HOME: home,
    USERPROFILE: home,
    SystemRoot: process.env.SystemRoot, // cmd.exe/where.exe need this on win32
    PATHEXT: process.env.PATHEXT, // where.exe matching of codex.cmd on win32
    ComSpec: process.env.ComSpec,
    // Hermetic os.tmpdir(): without TEMP/TMP Windows falls back to
    // %SystemRoot%\temp, where runCodex's --output-last-message write fails.
    TEMP: tmpDir,
    TMP: tmpDir,
    TMPDIR: tmpDir,
    CROSSVERIFY: '1',
    PATH: fakePathEntries(bin, { withCodex }).join(path.delimiter),
    FAKE_VERDICT_FILE: verdictFile,
  };
  return { root, home, state, cwd, bin, transcriptPath, env };
}

function runHook(sb, { session = 'sess1', hook = {}, env = {} } = {}) {
  const input = JSON.stringify({
    session_id: session,
    transcript_path: sb.transcriptPath,
    stop_hook_active: false,
    cwd: sb.cwd,
    ...hook,
  });
  const merged = { ...sb.env, ...env };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return spawnSync(process.execPath, [VERIFIER], {
    input,
    env: merged,
    cwd: sb.root,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function readLog(sb) {
  const p = path.join(sb.state, 'hook.log'); // spec: hook.log always lives in the state dir
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function reportFiles(sb) {
  const dir = path.join(sb.cwd, '.crossverify');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('formatBlockMessage matches the spec Agent UX template exactly', () => {
  // Schema-conformant shape: additionalProperties:false means the verdict
  // never carries a claims[] array — count comes from claims_failed/failed[].
  const verdict = {
    status: 'failed',
    confidence: 'FEEDBACK',
    claims_failed: 2,
    failed: [
      { claim: 'tests pass', evidence: 'node --test fails' },
      { claim: 'lint clean', evidence: 'eslint reports 3 errors' },
    ],
    feedback: 'src/app.mjs:12 — claim "tests pass" is false: node --test fails. Fix the assertion.',
  };
  assert.equal(formatBlockMessage(verdict, 1, 2), [
    '[crossverify] An independent verifier (different AI vendor, read-only) checked your last',
    'turn and found 2 failed claim(s). Fix the issues below, then finish normally.',
    'Do NOT disable the verifier or edit its config — fix the work instead.',
    'Attempt 1 of 2; after 2 the verifier defers and lets you stop.',
    'Failed claims:',
    '  ✗ tests pass — node --test fails',
    '  ✗ lint clean — eslint reports 3 errors',
    '---',
    'src/app.mjs:12 — claim "tests pass" is false: node --test fails. Fix the assertion.',
  ].join('\n'));
});

test('formatBlockMessage caps untrusted per-claim text and skips malformed entries', () => {
  const msg = formatBlockMessage({
    status: 'failed',
    failed: [
      { claim: 'c'.repeat(500), evidence: 'e'.repeat(900) },
      { notclaim: 'ignored' },
      null,
    ],
    feedback: 'fix',
  }, 1, 2);
  const line = msg.split('\n').find((l) => l.startsWith('  ✗'));
  assert.ok(line.length <= 4 + 200 + 3 + 300 + 10, `claim line too long: ${line.length}`);
  assert.equal(msg.split('\n').filter((l) => l.startsWith('  ✗')).length, 1);
});

test('formatBlockMessage counts from failed[] length when claims_failed is absent', () => {
  const verdict = {
    status: 'failed',
    failed: [
      { claim: 'a', evidence: 'x' },
      { claim: 'b', evidence: 'y' },
      { claim: 'c', evidence: 'z' },
    ],
    feedback: 'fix all three',
  };
  const msg = formatBlockMessage(verdict, 1, 2);
  assert.match(msg, /found 3 failed claim\(s\)/);
});

test('formatBlockMessage: falls back to 1 claim when claims absent and caps feedback length', () => {
  const msg = formatBlockMessage({ status: 'failed', feedback: 'x'.repeat(5000) }, 2, 2);
  assert.match(msg, /found 1 failed claim\(s\)/);
  assert.match(msg, /Attempt 2 of 2; after 2 the verifier defers and lets you stop\./);
  assert.ok(msg.includes('[feedback truncated by crossverify]'));
  assert.ok(msg.length < 4600);
});

test('gate: stop_hook_active skips immediately', (t) => {
  const sb = makeSandbox(t);
  const res = runHook(sb, { hook: { stop_hook_active: true } });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(readLog(sb), /skip: stop_hook_active/);
});

test('gate: disabled everywhere (public default OFF) skips and logs the deciding layer', (t) => {
  const sb = makeSandbox(t);
  const res = runHook(sb, { env: { CROSSVERIFY: undefined } });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(readLog(sb), /skip: disabled/);
});

test('gate: malformed stdin JSON passes through with exit 0 (fail-open)', (t) => {
  const sb = makeSandbox(t);
  const res = spawnSync(process.execPath, [VERIFIER], {
    input: 'not-json{',
    env: sb.env,
    cwd: sb.root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('gate: missing transcript skips', (t) => {
  const sb = makeSandbox(t);
  const res = runHook(sb, { hook: { transcript_path: path.join(sb.root, 'nope.jsonl') } });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(readLog(sb), /skip: no transcript/);
});

test('gate: last turn without mutations skips (per-turn gate)', (t) => {
  const sb = makeSandbox(t, { transcript: NO_MUTATION_TRANSCRIPT });
  const res = runHook(sb);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(readLog(sb), /skip: last turn has no mutations/);
});

test('gate: attempt counter at MAX_ATTEMPTS skips', (t) => {
  assert.equal(MAX_ATTEMPTS, 2);
  const sb = makeSandbox(t);
  fs.writeFileSync(path.join(sb.state, 'sess1.count'), '2');
  const res = runHook(sb);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(readLog(sb), /skip: hit MAX_ATTEMPTS=2/);
});

test('gate: codex binary missing logs and fails open', (t) => {
  const sb = makeSandbox(t, { withCodex: false });
  const res = runHook(sb);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(readLog(sb), /skip: codex not found/);
});

test('block mode: failed verdict emits block JSON, increments counter, writes report', (t) => {
  const sb = makeSandbox(t, { verdict: FAILED_VERDICT });
  const res = runHook(sb, { env: { CROSSVERIFY: 'foreground' } });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, 'block');
  assert.ok(out.reason.startsWith('[crossverify] An independent verifier (different AI vendor, read-only)'));
  assert.match(out.reason, /Attempt 1 of 2/);
  assert.ok(out.reason.includes(FAILED_VERDICT.feedback));
  assert.equal(fs.readFileSync(path.join(sb.state, 'sess1.count'), 'utf8'), '1');
  assert.equal(reportFiles(sb).length, 1);
});

test('security: hostile session_id is sanitized — no path escape from the state dir', (t) => {
  // session_id comes from hook stdin and feeds counter/report/staging
  // filenames. A traversal payload must be neutered, not honored.
  const sb = makeSandbox(t, { verdict: FAILED_VERDICT });
  const res = runHook(sb, { session: '../../evil', env: { CROSSVERIFY: 'foreground' } });
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).decision, 'block');
  // Counter lands inside the state dir under the sanitized name ('.' and '/'
  // both map to '_')...
  assert.equal(fs.readFileSync(path.join(sb.state, '______evil.count'), 'utf8'), '1');
  // ...and nowhere along the traversal path.
  assert.equal(fs.existsSync(path.join(sb.home, 'evil.count')), false);
  assert.equal(fs.existsSync(path.join(sb.home, '.claude', 'evil.count')), false);
  assert.equal(reportFiles(sb).length, 1);
});

test('block mode: verified verdict clears counter, writes report, gitignores .crossverify/ idempotently', (t) => {
  const sb = makeSandbox(t, { verdict: VERIFIED_VERDICT });
  fs.writeFileSync(path.join(sb.state, 'sess1.count'), '1');
  const res = runHook(sb, { env: { CROSSVERIFY: 'foreground' } });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.equal(fs.existsSync(path.join(sb.state, 'sess1.count')), false);
  assert.equal(reportFiles(sb).length, 1);
  const gi = fs.readFileSync(path.join(sb.cwd, '.gitignore'), 'utf8');
  assert.ok(gi.split(/\r?\n/).some((l) => l.trim() === '.crossverify/'));
  const res2 = runHook(sb, { env: { CROSSVERIFY: 'foreground' } });
  assert.equal(res2.status, 0);
  const gi2 = fs.readFileSync(path.join(sb.cwd, '.gitignore'), 'utf8');
  assert.equal(gi2.split(/\r?\n/).filter((l) => l.trim() === '.crossverify/').length, 1);
});

test('no .git dir: .crossverify created but .gitignore never written', (t) => {
  const sb = makeSandbox(t, { verdict: VERIFIED_VERDICT, gitRepo: false });
  const res = runHook(sb, { env: { CROSSVERIFY: 'foreground' } });
  assert.equal(res.status, 0);
  assert.equal(reportFiles(sb).length, 1);
  assert.equal(fs.existsSync(path.join(sb.cwd, '.gitignore')), false);
});

test('block mode: codex failure with default failmode=open passes through', (t) => {
  const sb = makeSandbox(t, { verdict: FAILED_VERDICT });
  const res = runHook(sb, { env: { CROSSVERIFY: 'foreground', FAKE_CODEX_EXIT: '1' } });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(readLog(sb), /failmode=open/);
});

test('block mode: failmode=closed infra failure is bounded by the attempt counter', (t) => {
  const sb = makeSandbox(t, { verdict: FAILED_VERDICT });
  fs.mkdirSync(path.join(sb.cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(sb.cwd, '.claude', 'crossverify.conf'), 'failmode=closed\n');

  const env = { CROSSVERIFY: 'foreground', FAKE_CODEX_EXIT: '1' };

  const res1 = runHook(sb, { env });
  assert.equal(res1.status, 0);
  const out1 = JSON.parse(res1.stdout);
  assert.equal(out1.decision, 'block');
  assert.match(out1.reason, /failmode=closed/);
  assert.match(out1.reason, /Attempt 1 of 2/);
  assert.equal(fs.readFileSync(path.join(sb.state, 'sess1.count'), 'utf8'), '1');

  const res2 = runHook(sb, { env });
  assert.equal(res2.status, 0);
  const out2 = JSON.parse(res2.stdout);
  assert.equal(out2.decision, 'block');
  assert.match(out2.reason, /Attempt 2 of 2/);
  assert.equal(fs.readFileSync(path.join(sb.state, 'sess1.count'), 'utf8'), '2');

  const res3 = runHook(sb, { env });
  assert.equal(res3.status, 0);
  assert.equal(res3.stdout, '');
  assert.match(readLog(sb), /skip: hit MAX_ATTEMPTS=2/);
});

test('background mode (default): exits immediately, detached child writes report', async (t) => {
  const sb = makeSandbox(t, { verdict: VERIFIED_VERDICT });
  const res = runHook(sb);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(readLog(sb), /background verify launched/);
  let files = [];
  for (let i = 0; i < 100; i += 1) {
    files = reportFiles(sb);
    if (files.length > 0) break;
    await sleep(100);
  }
  assert.equal(files.length, 1);
  const verdict = JSON.parse(fs.readFileSync(path.join(sb.cwd, '.crossverify', files[0]), 'utf8'));
  assert.equal(verdict.status, 'verified');
});

test('background mode: running marker is removed once the report lands', async (t) => {
  const sb = makeSandbox(t, { verdict: VERIFIED_VERDICT });
  const res = runHook(sb);
  assert.equal(res.status, 0);
  let files = [];
  for (let i = 0; i < 100; i += 1) {
    files = reportFiles(sb);
    if (files.length > 0) break;
    await sleep(100);
  }
  assert.equal(files.length, 1);
  const dir = path.join(sb.cwd, '.crossverify');
  assert.equal(fs.readdirSync(dir).some((f) => f.endsWith('.running')), false);
});

test('block mode: garbage codex output archives raw text and clears the running marker', (t) => {
  const sb = makeSandbox(t, { rawVerdictText: 'I could not verify anything, sorry.' });
  const res = runHook(sb, { env: { CROSSVERIFY: 'foreground' } });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  const dir = path.join(sb.cwd, '.crossverify');
  const files = fs.readdirSync(dir);
  const rawFiles = files.filter((f) => f.endsWith('.raw.txt'));
  assert.equal(rawFiles.length, 1);
  assert.equal(
    fs.readFileSync(path.join(dir, rawFiles[0]), 'utf8'),
    'I could not verify anything, sorry.'
  );
  assert.equal(files.some((f) => f.endsWith('.running')), false);
});

// C2: background mode is the DEFAULT and had zero failure-path coverage —
// only the happy path (verified verdict) was tested. These mirror the
// existing background test's polling pattern but assert on the detached
// child's failure handling instead: the .raw.txt archive / log line, and
// that the .running marker is always cleaned up even when codex fails.

test('background mode: garbage codex output archives raw text and clears the running marker', async (t) => {
  const sb = makeSandbox(t, { rawVerdictText: 'this is not json' });
  const res = runHook(sb);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(readLog(sb), /background verify launched/);
  const dir = path.join(sb.cwd, '.crossverify');
  // Poll until the .running marker is gone (removed in the child's `finally`,
  // AFTER the raw archive is written) rather than on the raw file's mere
  // existence — otherwise there is a real race window between the archive
  // landing and the marker being cleaned up.
  let running = true;
  for (let i = 0; i < 100; i += 1) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    running = files.some((f) => f.endsWith('.running'));
    if (!running) break;
    await sleep(100);
  }
  assert.equal(running, false);
  const files = fs.readdirSync(dir);
  const rawFiles = files.filter((f) => f.endsWith('.raw.txt'));
  assert.equal(rawFiles.length, 1);
  assert.equal(
    fs.readFileSync(path.join(dir, rawFiles[0]), 'utf8'),
    'this is not json'
  );
  assert.match(readLog(sb), /child: codex failed or invalid verdict \(verifier output not valid JSON/);
  assert.equal(files.filter((f) => f.endsWith('.json')).length, 0);
});

test('background mode: codex exit failure logs the failure and clears the running marker, no report written', async (t) => {
  const sb = makeSandbox(t, { verdict: VERIFIED_VERDICT });
  const res = runHook(sb, { env: { FAKE_CODEX_EXIT: '1' } });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  const dir = path.join(sb.cwd, '.crossverify');
  let running = true;
  for (let i = 0; i < 100; i += 1) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    running = files.some((f) => f.endsWith('.running'));
    if (!running) break;
    await sleep(100);
  }
  assert.equal(running, false, 'running marker must be removed even on codex failure');
  assert.match(readLog(sb), /child: codex failed or invalid verdict \(codex exited with code 1/);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.equal(files.filter((f) => f.endsWith('.json')).length, 0, 'no report JSON on codex failure');
});

// I1(a): rule-pack fallback (verifier.mjs ~219-232) — an unknown project
// pack= must fall back to default.md and verification must still proceed,
// not silently skip.
test('rule pack fallback: unknown project pack falls back to default.md and verify still runs', async (t) => {
  const sb = makeSandbox(t, { verdict: VERIFIED_VERDICT });
  fs.mkdirSync(path.join(sb.cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(sb.cwd, '.claude', 'crossverify.conf'), 'pack=doesnotexist\n');
  const res = runHook(sb);
  assert.equal(res.status, 0);
  assert.match(readLog(sb), /warn: rule pack 'doesnotexist' missing at .*doesnotexist\.md — falling back to default/);
  let files = [];
  for (let i = 0; i < 100; i += 1) {
    files = reportFiles(sb);
    if (files.length > 0) break;
    await sleep(100);
  }
  assert.equal(files.length, 1, 'verify must still run against default.md, not skip');
});

// I1(b): missing verifier assets (verifier.mjs ~227-232) must fail OPEN —
// exit 0, log the skip, never block the builder. Assets are resolved
// relative to the verifier script itself (VERIFIER_DIR = SCRIPT_DIR/../verifier),
// so to sandbox a missing asset we copy the whole plugin/ tree and spawn
// THAT copy of verifier.mjs, with system-prompt.md deleted from the copy.
test('missing verifier asset (system-prompt.md) fails open: exit 0, logs skip, never blocks', (t) => {
  const sb = makeSandbox(t, { verdict: VERIFIED_VERDICT });
  const pluginCopy = path.join(sb.root, 'plugin-copy');
  fs.cpSync(path.join(REPO_ROOT, 'plugin'), pluginCopy, { recursive: true });
  const missingAsset = path.join(pluginCopy, 'verifier', 'system-prompt.md');
  fs.rmSync(missingAsset, { force: true });
  const verifierCopy = path.join(pluginCopy, 'scripts', 'verifier.mjs');

  const input = JSON.stringify({
    session_id: 'sess-missing-asset',
    transcript_path: sb.transcriptPath,
    stop_hook_active: false,
    cwd: sb.cwd,
  });
  const res = spawnSync(process.execPath, [verifierCopy], {
    input,
    env: sb.env,
    cwd: sb.root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(readLog(sb), /skip: missing verifier asset .*system-prompt\.md \(fail-open\)/);
});

test('verifier.mjs runs (logs "fired") when invoked via a symlinked path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-hook-symlink-'));
  const realHook = path.join(process.cwd(), 'plugin', 'scripts', 'verifier.mjs');
  const link = path.join(tmp, 'hook-shim.mjs');
  fs.symlinkSync(realHook, link);
  const res = spawnSync(process.execPath, [link], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
    input: JSON.stringify({
      session_id: 'symlink-smoke',
      transcript_path: '/nonexistent',
      stop_hook_active: false,
      cwd: tmp,
    }),
  });
  assert.equal(res.status, 0);
  // Before the shared realpath guard, main() never ran through a symlink and
  // no log was written. Now the very first log line must exist.
  const logFile = path.join(tmp, '.claude', 'crossverify', 'hook.log');
  assert.ok(fs.existsSync(logFile), 'hook.log must exist — main() must run through symlinks');
  assert.match(fs.readFileSync(logFile, 'utf8'), /fired session=symlink-smoke/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('output=global: report lands in global dir, staging stays inside the workspace, .gitignore appended', (t) => {
  const sb = makeSandbox(t, { verdict: VERIFIED_VERDICT });
  fs.mkdirSync(path.join(sb.cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(sb.cwd, '.claude', 'crossverify.conf'), 'output=global\n');
  const res = runHook(sb, { env: { CROSSVERIFY: 'foreground' } });
  assert.equal(res.status, 0);
  const globalReports = path.join(sb.state, 'reports');
  const reports = fs.readdirSync(globalReports).filter((f) => f.endsWith('.json'));
  assert.equal(reports.length, 1);
  // Staging dir must be project-local (codex --cd sandbox can read it) and
  // gitignored on first creation, even though reports go global.
  assert.ok(fs.existsSync(path.join(sb.cwd, '.crossverify')));
  const gi = fs.readFileSync(path.join(sb.cwd, '.gitignore'), 'utf8');
  assert.match(gi, /\.crossverify\//);
  const leftovers = fs.readdirSync(path.join(sb.cwd, '.crossverify'))
    .filter((f) => f.endsWith('.turn.jsonl') || f.endsWith('.rules.md'));
  assert.deepEqual(leftovers, []);
});

test('gc: stale staged/marker/payload/counter files swept; reports and fresh files kept', (t) => {
  const sb = makeSandbox(t, { verdict: VERIFIED_VERDICT });
  const projDir = path.join(sb.cwd, '.crossverify');
  fs.mkdirSync(projDir, { recursive: true });
  const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  const staleTurn = path.join(projDir, 'dead-1.turn.jsonl');
  const staleRun = path.join(projDir, 'dead-1.running');
  const staleRules = path.join(projDir, 'dead-1.rules.md');
  const oldReport = path.join(projDir, 'dead-1.json');
  const stalePayload = path.join(sb.state, 'dead-1.payload.json');
  const staleCount = path.join(sb.state, 'dead.count');
  const freshCount = path.join(sb.state, 'recent.count');
  for (const f of [staleTurn, staleRun, staleRules, oldReport, stalePayload]) {
    fs.writeFileSync(f, 'x');
    fs.utimesSync(f, twoHoursAgo, twoHoursAgo);
  }
  fs.writeFileSync(staleCount, '1');
  fs.utimesSync(staleCount, eightDaysAgo, eightDaysAgo);
  fs.writeFileSync(freshCount, '1');
  const res = runHook(sb, { env: { CROSSVERIFY: 'foreground' } });
  assert.equal(res.status, 0);
  for (const f of [staleTurn, staleRun, staleRules, stalePayload, staleCount]) {
    assert.equal(fs.existsSync(f), false, `expected swept: ${path.basename(f)}`);
  }
  assert.equal(fs.existsSync(oldReport), true, 'reports are user data — never swept');
  assert.equal(fs.existsSync(freshCount), true, 'fresh counters survive the sweep');
});
