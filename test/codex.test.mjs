// Tests for plugin/scripts/lib/codex.mjs — prompt building and the codex exec runner.
// runCodex is exercised against a FAKE `codex` executable written into a temp dir
// that is prepended to PATH, so no real Codex CLI (and no network) is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPrompt, runCodex, validateVerdict, resolveCodexCommand } from '../plugin/scripts/lib/codex.mjs';
import { installFakeCodex, fakePathEntries } from './helpers/fake-codex.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crossverify-codex-test-'));
}

// Writes an executable `codex` script into dir. It finds the --output-last-message
// argument, waits delayMs, writes payload there (with __CODEX_HOME__ substituted
// from its environment), and exits 0. Cross-platform: see helpers/fake-codex.mjs
// (POSIX shebang script; Windows codex.cmd shim — which also exercises
// resolveCodexCommand's cmd.exe wrapping for real).

// Runs fn with the fake codex first on PATH; always restores PATH and removes the dir.
async function withFakeCodex(opts, fn) {
  const dir = makeTempDir();
  installFakeCodex(dir, opts);
  const schemaPath = path.join(dir, 'schema.json');
  fs.writeFileSync(schemaPath, '{}');
  const oldPath = process.env.PATH;
  // Full-replace PATH (matches verifier.test.mjs's sandbox strategy) — do NOT
  // append the real oldPath tail. resolveCodexCommand on win32 scans ALL
  // where.exe matches and prefers a .exe hit, so a stray real codex.exe
  // reachable via the inherited PATH could beat our fake codex.cmd. Other env
  // vars (SystemRoot/PATHEXT/ComSpec) stay untouched via {...process.env} in
  // runCodex, so cmd.exe/where.exe resolution still works on Windows.
  process.env.PATH = fakePathEntries(dir).join(path.delimiter);
  try {
    return await fn({ dir, schemaPath });
  } finally {
    process.env.PATH = oldPath;
    // maxRetries: on Windows a just-killed cmd.exe's node grandchild can hold
    // the dir briefly (EBUSY); retry instead of failing the test in cleanup.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
}

test('buildPrompt mirrors the bash reference layout', () => {
  const prompt = buildPrompt({
    systemPromptText: 'SYSTEM PROMPT BODY',
    cwd: '/some/project',
    transcriptPath: '/some/transcript.jsonl',
    rulesPath: '/some/rules/default.md',
    attempt: 1,
    maxAttempts: 2,
  });
  assert.ok(prompt.startsWith('SYSTEM PROMPT BODY\n\n---\n\n'));
  assert.ok(prompt.includes('WORKING_DIR: /some/project\n'));
  assert.ok(prompt.includes('TRANSCRIPT_PATH: /some/transcript.jsonl\n'));
  assert.ok(prompt.includes('RULES: /some/rules/default.md\n'));
  assert.ok(prompt.includes('ATTEMPT: 1 of 2\n'));
  assert.ok(prompt.endsWith(
    "Read the rules file. Read the transcript. Verify the builder's work. Output JSON only, matching the schema."
  ));
});

test('validateVerdict accepts each allowed status', () => {
  assert.equal(validateVerdict({ status: 'verified' }), true);
  assert.equal(validateVerdict({ status: 'failed', feedback: 'fix x' }), true);
  assert.equal(validateVerdict({ status: 'unsure' }), true);
});

test('validateVerdict rejects bad shapes', () => {
  assert.equal(validateVerdict(null), false);
  assert.equal(validateVerdict(undefined), false);
  assert.equal(validateVerdict('verified'), false);
  assert.equal(validateVerdict([]), false);
  assert.equal(validateVerdict({}), false);
  assert.equal(validateVerdict({ status: 'maybe' }), false);
  assert.equal(validateVerdict({ status: 1 }), false);
});

test('runCodex returns the parsed verdict from a valid run', async () => {
  const verdict = { status: 'verified', summary: 'all claims check out', feedback: '' };
  await withFakeCodex({ payload: JSON.stringify(verdict) }, async ({ dir, schemaPath }) => {
    const res = await runCodex({ prompt: 'p', cwd: dir, model: 'gpt-5.4', schemaPath, timeoutMs: 5000 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.verdict, verdict);
    assert.equal(res.error, undefined);
  });
});

test('runCodex strips markdown fences around the JSON', async () => {
  const verdict = { status: 'failed', feedback: 'file.mjs:3 claim not backed by code' };
  const payload = '```json\n' + JSON.stringify(verdict) + '\n```\n';
  await withFakeCodex({ payload }, async ({ dir, schemaPath }) => {
    const res = await runCodex({ prompt: 'p', cwd: dir, model: 'gpt-5.4', schemaPath, timeoutMs: 5000 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.verdict, verdict);
  });
});

test('runCodex on garbage output saves raw and fails open', async () => {
  const payload = 'I could not verify anything, sorry.';
  await withFakeCodex({ payload }, async ({ dir, schemaPath }) => {
    const res = await runCodex({ prompt: 'p', cwd: dir, model: 'gpt-5.4', schemaPath, timeoutMs: 5000 });
    assert.equal(res.ok, false);
    assert.match(res.error, /not valid JSON/);
    assert.ok(res.rawPath, 'rawPath must point at the saved raw output');
    assert.equal(fs.readFileSync(res.rawPath, 'utf8'), payload);
    fs.rmSync(res.rawPath, { force: true });
  });
});

test('runCodex rejects valid JSON that fails the verdict shape check', async () => {
  await withFakeCodex({ payload: JSON.stringify({ status: 'maybe' }) }, async ({ dir, schemaPath }) => {
    const res = await runCodex({ prompt: 'p', cwd: dir, model: 'gpt-5.4', schemaPath, timeoutMs: 5000 });
    assert.equal(res.ok, false);
    assert.match(res.error, /shape check/);
    assert.ok(res.rawPath);
    fs.rmSync(res.rawPath, { force: true });
  });
});

test('runCodex times out a slow codex and reports it', async () => {
  const payload = JSON.stringify({ status: 'verified' });
  await withFakeCodex({ payload, delayMs: 2000 }, async ({ dir, schemaPath }) => {
    const res = await runCodex({ prompt: 'p', cwd: dir, model: 'gpt-5.4', schemaPath, timeoutMs: 500 });
    assert.equal(res.ok, false);
    assert.match(res.error, /timed out after 500ms/);
  });
});

test('security: prompt reaches codex via stdin byte-identical — shell metachars inert', async () => {
  // The prompt carries builder-controlled text. It must arrive as data on
  // stdin, never re-parsed by a shell: the fake echoes stdin back as the
  // verdict, so a byte-identical round trip proves nothing interpreted it.
  const hostile = 'evil $(touch pwned) `touch pwned` %PATH% "q" \'s\' \\b\\ ; & | > < !\nline2';
  const prompt = JSON.stringify({ status: 'verified', feedback: hostile });
  await withFakeCodex({ echoStdin: true }, async ({ dir, schemaPath }) => {
    const res = await runCodex({ prompt, cwd: dir, model: 'gpt-5.4', schemaPath, timeoutMs: 5000 });
    assert.equal(res.ok, true);
    assert.equal(res.verdict.feedback, hostile);
    assert.equal(fs.existsSync(path.join(dir, 'pwned')), false, 'metachar in prompt must never execute');
  });
});

test('runCodex passes codexHome to the child as CODEX_HOME', async () => {
  const payload = JSON.stringify({ status: 'verified', feedback: '__CODEX_HOME__' });
  await withFakeCodex({ payload }, async ({ dir, schemaPath }) => {
    const codexHome = path.join(dir, 'codex-home');
    const res = await runCodex({ prompt: 'p', cwd: dir, model: 'gpt-5.4', schemaPath, timeoutMs: 5000, codexHome });
    assert.equal(res.ok, true);
    assert.equal(res.verdict.feedback, codexHome);
  });
});

// ---- security regressions ----

// On Windows a `.cmd` shim can't be spawned with shell:false, so the argv
// crosses cmd.exe — where &, |, (, ) are operators. Node quotes an argument
// only when it contains a space, tab, or quote, so a space-free payload in
// --model (CROSSVERIFY_MODEL) or --cd (the project path) EXECUTED. Confirmed
// live on Windows 11 / Node 22 before the fix.
test('resolveCodexCommand: exposes a verbatim flag matching the lane', () => {
  const resolved = resolveCodexCommand();
  assert.equal(typeof resolved.command, 'string');
  assert.equal(typeof resolved.wrap, 'function');
  if (process.platform !== 'win32') {
    assert.equal(resolved.verbatim, false, 'POSIX never needs verbatim args');
    assert.deepEqual(resolved.wrap(['exec', '--model', 'a&b']), ['exec', '--model', 'a&b']);
  } else {
    assert.equal(typeof resolved.verbatim, 'boolean');
  }
});

test('resolveCodexCommand (win32 cmd lane): every argument is quoted, metacharacters inert', { skip: process.platform !== 'win32' ? 'win32 only' : false }, () => {
  const resolved = resolveCodexCommand();
  if (resolved.command.toLowerCase() !== 'cmd.exe') return; // .exe lane, no shell involved
  const wrapped = resolved.wrap(['exec', '--model', 'gpt-5&whoami&rem', '--cd', 'C:\\proj a\\b']);
  assert.deepEqual(wrapped.slice(0, 3), ['/d', '/s', '/c']);
  const line = wrapped[3];
  assert.equal(resolved.verbatim, true, 'Node must not re-quote what we quoted');
  // /s strips the outermost quote pair, so the line needs one extra.
  assert.ok(line.startsWith('""') || line.startsWith('"'), 'command line must be quote-wrapped');
  assert.ok(line.endsWith('"'), 'command line must end quoted');
  // No metacharacter may sit outside a quoted run.
  assert.ok(
    /"gpt-5&whoami&rem"/.test(line),
    `payload must be quoted, got: ${line}`
  );
  assert.ok(/"C:\\proj a\\b"/.test(line), 'paths with spaces must survive');
});

test('runCodex: an argument containing a quote is refused, not shell-escaped', async (t) => {
  if (process.platform !== 'win32') return; // only the cmd lane refuses
  const resolved = resolveCodexCommand();
  if (resolved.command.toLowerCase() !== 'cmd.exe') return;
  assert.throws(() => resolved.wrap(['exec', '--model', 'a"b']), /refusing to pass an argument/);
});
