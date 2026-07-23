#!/usr/bin/env node
// plugin/scripts/verifier.mjs — CrossVerify Stop-hook entry.
//
// stdin (from Claude Code):  {"session_id","transcript_path","stop_hook_active","cwd"}
// stdout: nothing (let builder stop) or {"decision":"block","reason":"..."} (foreground mode)
// Exit code is ALWAYS 0 — verifier infrastructure must never break the builder
// (fail-open principle; failmode=closed only changes what happens on a verdict
// error in foreground mode, never the exit code).
//
// Child mode: `node verifier.mjs --verify-child <payload.json>` runs codex and
// writes the report file — used by the detached background spawn.
//
// Gate order mirrors the proven bash reference hook:
// stop_hook_active -> enabled -> transcript -> per-turn mutation -> attempt
// counter -> codex binary -> run.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveConfig, reportsDir, stateDir, projectKey, log } from './lib/config.mjs';
import { sliceLastTurn, hasMutation } from './lib/transcript.mjs';
import { buildPrompt, runCodex, validateVerdict, probeCodex } from './lib/codex.mjs';
import { applyResearch } from './lib/research.mjs';
import { isMainModule } from './lib/entry.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERIFIER_DIR = path.join(SCRIPT_DIR, '..', 'verifier');

export const MAX_ATTEMPTS = 2;
const CODEX_TIMEOUT_MS = 180_000;
const DEFAULT_MODEL = 'gpt-5.4';
const FEEDBACK_CAP = 4000; // spec: feedback text is untrusted — length-cap it

// Spec "Agent UX" block-message template, verbatim structure.
export function formatBlockMessage(verdict, attempt, maxAttempts) {
  // The schema (additionalProperties:false) never produces a claims[] array —
  // count from claims_failed, falling back to the failed[] array length, and
  // only defaulting to 1 when neither is present.
  const n = verdict.claims_failed
    ?? (Array.isArray(verdict.failed) ? verdict.failed.length : 1);
  let feedback = typeof verdict.feedback === 'string' ? verdict.feedback : '';
  if (feedback.length > FEEDBACK_CAP) {
    feedback = `${feedback.slice(0, FEEDBACK_CAP)}\n[feedback truncated by crossverify]`;
  }
  return [
    '[crossverify] An independent verifier (different AI vendor, read-only) checked your last',
    `turn and found ${n} failed claim(s). Fix the issues below, then finish normally.`,
    'Do NOT disable the verifier or edit its config — fix the work instead.',
    `Attempt ${attempt} of ${maxAttempts}; after ${maxAttempts} the verifier defers and lets you stop.`,
    '---',
    feedback,
  ].join('\n');
}

// UTC digits down to the millisecond: two Stops in the same session within
// one second must not collide on report/marker/staged filenames.
const timestamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 17);

function readCounter(file) {
  try {
    const n = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

// Create a project-local .crossverify/ dir (staging always; reports too when
// output=project). On FIRST creation inside a git repo, append
// ".crossverify/" to .gitignore (idempotent; skipped entirely when the
// project has no .git).
function ensureProjectDir(dir, cwd) {
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  if (existed) return;
  if (!fs.existsSync(path.join(cwd, '.git'))) return;
  const gitignorePath = path.join(cwd, '.gitignore');
  const line = '.crossverify/';
  let text = '';
  if (fs.existsSync(gitignorePath)) text = fs.readFileSync(gitignorePath, 'utf8');
  if (text.split(/\r?\n/).some((l) => l.trim() === line)) return;
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(gitignorePath, `${sep}${line}\n`);
  log(`gitignore: appended '${line}' to ${gitignorePath}`);
}

// Best-effort GC for state a crashed background child never cleaned up:
// staged inputs / running markers / payloads go stale after an hour (codex
// timeout is 3 min); per-session attempt counters after a week. Reports are
// user data — never swept. Must never throw past the caller.
const STALE_RUN_MS = 60 * 60 * 1000;
const STALE_COUNTER_MS = 7 * 24 * 60 * 60 * 1000;
function sweepStaleState(dirs) {
  const now = Date.now();
  for (const dir of new Set(dirs)) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const runStale = name.endsWith('.running') || name.endsWith('.turn.jsonl')
        || name.endsWith('.rules.md') || name.endsWith('.payload.json');
      const counterStale = name.endsWith('.count');
      if (!runStale && !counterStale) continue;
      const full = path.join(dir, name);
      try {
        const age = now - fs.statSync(full).mtimeMs;
        if (age > (runStale ? STALE_RUN_MS : STALE_COUNTER_MS)) {
          fs.rmSync(full, { force: true });
          log(`gc: removed stale ${name}`);
        }
      } catch { /* best effort */ }
    }
  }
}

// A verdict of `unsure` with ZERO claims means codex observed nothing at all.
// On Windows that is the known signature of the codex sandbox-runner failing
// to execute tools (named-pipe IPC; see openai/codex #31744/#32655 family) —
// annotate the report so the user gets a diagnosis instead of a silently
// useless file. Never changes the verdict.
function annotateVerdict(verdict) {
  if (
    process.platform === 'win32' &&
    verdict.status === 'unsure' &&
    (verdict.claims_total === 0 || verdict.claims_total === undefined)
  ) {
    return {
      ...verdict,
      windows_hint:
        'Verifier could not observe anything: codex executed no read tools. Known codex-on-Windows sandbox issue. Checks: (1) npm installs may lack the platform package — run `npm install --include=optional` inside node_modules/@openai/codex; (2) sandboxed exec needs an interactive desktop session (fails under SSH/service sessions); (3) see openai/codex issues #31744, #32655, #20919.',
    };
  }
  return verdict;
}

// Archive a codex-run's raw last-message file (returned as result.rawPath on
// JSON-parse or shape-check failure) next to the report, then remove the temp
// original. Best-effort: archival must never throw past the caller.
function archiveRaw(rawPath, reportFile) {
  const archivePath = reportFile.replace(/\.json$/, '.raw.txt');
  try {
    fs.copyFileSync(rawPath, archivePath);
    fs.rmSync(rawPath, { force: true });
    return archivePath;
  } catch (err) {
    log(`warn: failed to archive raw output ${rawPath}: ${err.message}`);
    return null;
  }
}

// Detached background worker: run codex, write the report, clean up payload.
async function runChild(payloadFile) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
  } catch (err) {
    log(`child: unreadable payload ${payloadFile}: ${err.message}`);
    return;
  }
  try {
    const result = await runCodex({
      prompt: payload.prompt,
      cwd: payload.cwd,
      model: payload.model,
      schemaPath: payload.schemaPath,
      timeoutMs: payload.timeoutMs,
      codexHome: payload.codexHome,
    });
    if (result.ok && validateVerdict(result.verdict)) {
      let verdict = result.verdict;
      if (payload.research === 'on') {
        verdict = await applyResearch(verdict, {
          model: payload.model, timeoutMs: payload.timeoutMs,
          codexHome: payload.codexHome, schemaPath: payload.researchSchemaPath, log,
        });
      }
      const annotated = annotateVerdict(verdict);
      fs.writeFileSync(payload.reportFile, `${JSON.stringify(annotated, null, 2)}\n`);
      log(`child: verdict status=${result.verdict.status} report=${payload.reportFile}`);
      if (annotated.windows_hint) log(`windows_hint: ${annotated.windows_hint}`);
    } else {
      let archived = null;
      if (result.rawPath) archived = archiveRaw(result.rawPath, payload.reportFile);
      log(`child: codex failed or invalid verdict (${result.error || 'schema mismatch'})${archived ? ` raw=${archived}` : ''}`);
    }
  } finally {
    fs.rmSync(payloadFile, { force: true });
    if (payload.runningMarker) fs.rmSync(payload.runningMarker, { force: true });
    for (const staged of payload.stagedFiles ?? []) fs.rmSync(staged, { force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--verify-child') {
    await runChild(argv[1]);
    return;
  }

  let hook = {};
  try {
    hook = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    // Unreadable or malformed hook input: fail open with defaults below.
  }
  const rawSessionId = typeof hook.session_id === 'string' && hook.session_id !== '' ? hook.session_id : 'unknown';
  // Session IDs land directly in filenames (counter file, report, running
  // marker) — sanitize before they ever touch a path.
  const sessionId = rawSessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  const transcriptPath = typeof hook.transcript_path === 'string' ? hook.transcript_path : '';
  const cwd = typeof hook.cwd === 'string' && hook.cwd !== '' ? hook.cwd : process.cwd();

  log(`fired session=${sessionId} cwd=${cwd} stop_hook_active=${hook.stop_hook_active === true}`);

  // Gate 1: loop guard — we triggered this stop ourselves.
  if (hook.stop_hook_active === true) {
    log('skip: stop_hook_active');
    return;
  }

  // Gate 2: layered enable (env > project > global > default; force/lock inside
  // resolveConfig). Spec Tamper lock: a disable is never silent — log all notes
  // (resolveConfig pushes one whenever a project-level disable is honored or a
  // locked disable is ignored) plus the deciding layer.
  const config = resolveConfig({ cwd, env: process.env });
  for (const note of config.notes ?? []) log(`note: ${note}`);
  if (!config.enabled) {
    log(`skip: disabled (decidedBy=${config.decidedBy?.enabled ?? 'default'})`);
    return;
  }

  // Gate 3: transcript must exist.
  if (transcriptPath === '' || !fs.existsSync(transcriptPath)) {
    log(`skip: no transcript at ${transcriptPath || '(none)'}`);
    return;
  }

  // Gate 4: per-turn no-changes skip.
  const transcriptText = fs.readFileSync(transcriptPath, 'utf8');
  if (!hasMutation(sliceLastTurn(transcriptText))) {
    log('skip: last turn has no mutations (per-turn gate)');
    return;
  }

  // Gate 5: per-session attempt counter.
  fs.mkdirSync(stateDir(), { recursive: true });
  const counterFile = path.join(stateDir(), `${sessionId}.count`);
  const attempts = readCounter(counterFile);
  if (attempts >= MAX_ATTEMPTS) {
    log(`skip: hit MAX_ATTEMPTS=${MAX_ATTEMPTS} for session=${sessionId}`);
    return;
  }

  // Gate 6: codex binary present (fail-open when missing). Same resolution
  // logic as runCodex (see lib/codex.mjs resolveCodexCommand) so this probe
  // and the real run agree on Windows, where a bare shell:false spawn of a
  // .cmd shim fails even though shell:true (the old probe) succeeded.
  if (!probeCodex()) {
    log('skip: codex not found on PATH (fail-open)');
    return;
  }

  // Verifier assets live OUTSIDE the project (tamper lock): plugin dir.
  const systemPromptPath = path.join(VERIFIER_DIR, 'system-prompt.md');
  const schemaPath = path.join(VERIFIER_DIR, 'output-schema.json');
  let rulesPath = path.join(VERIFIER_DIR, 'rules', `${config.pack}.md`);
  if (!fs.existsSync(rulesPath)) {
    log(`warn: rule pack '${config.pack}' missing at ${rulesPath} — falling back to default`);
    rulesPath = path.join(VERIFIER_DIR, 'rules', 'default.md');
  }
  for (const f of [systemPromptPath, schemaPath, rulesPath]) {
    if (!fs.existsSync(f)) {
      log(`skip: missing verifier asset ${f} (fail-open)`);
      return;
    }
  }

  const reportDir = reportsDir(config, cwd);
  // Staging ALWAYS lives inside the workspace (see the staging comment
  // below) — with output=global the report dir is under ~/.claude, outside
  // the --cd workspace, and codex's Windows sandbox could not read staged
  // inputs there.
  const stagingDir = path.join(cwd, '.crossverify');
  ensureProjectDir(stagingDir, cwd);
  fs.mkdirSync(reportDir, { recursive: true });
  sweepStaleState([stateDir(), reportDir, stagingDir]);
  const ts = timestamp();
  // Global output shares one dir across every project — prefix with the
  // project key so report readers can filter to THIS project (see
  // config.mjs projectKey). Project-local dirs need no discriminator.
  const namePrefix = config.output === 'global' ? `${projectKey(cwd)}-` : '';
  const reportFile = path.join(reportDir, `${namePrefix}${sessionId}-${ts}.json`);
  // Empty marker so the statusline can show a running indicator while codex
  // is still working; removed once the report (or a terminal failure) lands.
  const runningMarker = path.join(reportDir, `${namePrefix}${sessionId}-${ts}.running`);

  const model = process.env.CROSSVERIFY_MODEL || DEFAULT_MODEL;
  // Stage the verification inputs INSIDE the workspace. Codex's Windows
  // sandbox restricts reads to the --cd workspace, and both the transcript
  // (~/.claude/projects/...) and the rules pack (plugin dir) live outside it —
  // observed live on Windows as status=unsure with zero claims ("workspace
  // contents not accessible"). macOS seatbelt only restricts writes, which
  // hid this. Staging the LAST-TURN SLICE (not the full transcript) also
  // means the verifier reads exactly what it is meant to judge.
  const stagedTurnPath = path.join(stagingDir, `${sessionId}-${ts}.turn.jsonl`);
  const stagedRulesPath = path.join(stagingDir, `${sessionId}-${ts}.rules.md`);
  fs.writeFileSync(stagedTurnPath, sliceLastTurn(transcriptText));
  fs.copyFileSync(rulesPath, stagedRulesPath);
  const prompt = buildPrompt({
    systemPromptText: fs.readFileSync(systemPromptPath, 'utf8'),
    cwd,
    transcriptPath: stagedTurnPath,
    rulesPath: stagedRulesPath,
    attempt: attempts + 1,
    maxAttempts: MAX_ATTEMPTS,
    research: config.research,
  });
  const codexHomeDir = path.join(stateDir(), 'codex-home');
  const codexHome = fs.existsSync(codexHomeDir) ? codexHomeDir : undefined;

  if (config.mode !== 'foreground') {
    // BACKGROUND (default): detach a child that runs codex + writes the report,
    // then let the builder stop immediately.
    const payloadFile = path.join(stateDir(), `${sessionId}-${ts}.payload.json`);
    fs.writeFileSync(runningMarker, '');
    fs.writeFileSync(payloadFile, JSON.stringify({
      prompt, cwd, model, schemaPath, timeoutMs: CODEX_TIMEOUT_MS, codexHome, reportFile, runningMarker,
      research: config.research,
      researchSchemaPath: path.join(VERIFIER_DIR, 'research-schema.json'),
      stagedFiles: [stagedTurnPath, stagedRulesPath],
    }));
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--verify-child', payloadFile], {
      detached: true,
      windowsHide: true, // detached on Windows otherwise pops a console window per verify
      stdio: 'ignore',
    });
    // Async spawn failures (EMFILE/EACCES) emit 'error' after main() resolves —
    // without a listener that is an uncaught throw, the one hole in fail-open.
    child.on('error', (err) => {
      try { log(`background spawn error: ${err.message}`); } catch { /* never throw */ }
    });
    child.unref();
    log(`background verify launched model=${model} (report will land at ${reportFile})`);
    return;
  }

  // FOREGROUND mode: wait for the verdict, block on a failed one.
  fs.writeFileSync(runningMarker, '');
  log(`running codex model=${model} attempt=${attempts + 1} mode=foreground`);
  const result = await runCodex({ prompt, cwd, model, schemaPath, timeoutMs: CODEX_TIMEOUT_MS, codexHome });
  fs.rmSync(runningMarker, { force: true });
  fs.rmSync(stagedTurnPath, { force: true });
  fs.rmSync(stagedRulesPath, { force: true });
  if (!result.ok || !validateVerdict(result.verdict)) {
    let archived = null;
    if (result.rawPath) archived = archiveRaw(result.rawPath, reportFile);
    log(`codex failed or invalid verdict (${result.error || 'schema mismatch'}) — failmode=${config.failmode}${archived ? ` raw=${archived}` : ''}`);
    if (config.failmode === 'closed') {
      // Bound infra failures the same way as failed verdicts: increment the
      // attempt counter so Gate 5 defers after MAX_ATTEMPTS, instead of
      // blocking every Stop forever on persistent codex failure (auth
      // expiry, network, etc).
      const attempt = attempts + 1;
      fs.writeFileSync(counterFile, String(attempt));
      process.stdout.write(`${JSON.stringify({
        decision: 'block',
        reason: [
          `[crossverify] Verifier infrastructure failed (failmode=closed): ${result.error || 'schema mismatch'}.`,
          'Ask the user to check `crossverify report` (or `node .../cli.mjs report` if not on PATH) and hook.log before finishing.',
          'Do NOT disable the verifier or edit its config.',
          `Attempt ${attempt} of ${MAX_ATTEMPTS}; after ${MAX_ATTEMPTS} the verifier defers and lets you stop.`,
        ].join('\n'),
      })}\n`);
    }
    return;
  }

  let verdict = result.verdict;
  if (config.research === 'on') {
    verdict = await applyResearch(verdict, {
      model, timeoutMs: CODEX_TIMEOUT_MS, codexHome,
      schemaPath: path.join(VERIFIER_DIR, 'research-schema.json'), log,
    });
  }
  const annotated = annotateVerdict(verdict);
  fs.writeFileSync(reportFile, `${JSON.stringify(annotated, null, 2)}\n`);
  log(`verdict status=${verdict.status} report=${reportFile}`);
  if (annotated.windows_hint) log(`windows_hint: ${annotated.windows_hint}`);

  const feedback = typeof verdict.feedback === 'string' ? verdict.feedback.trim() : '';
  if (verdict.status === 'failed' && feedback !== '') {
    const attempt = attempts + 1;
    fs.writeFileSync(counterFile, String(attempt));
    process.stdout.write(`${JSON.stringify({
      decision: 'block',
      reason: formatBlockMessage(verdict, attempt, MAX_ATTEMPTS),
    })}\n`);
    return;
  }

  // verified or unsure — let the builder stop and reset the loop bound.
  fs.rmSync(counterFile, { force: true });
}

if (isMainModule(import.meta.url)) {
  main()
    .catch((err) => {
      try {
        log(`error: ${err && err.stack ? err.stack : String(err)}`);
      } catch {
        // Logging must never crash the hook.
      }
    })
    .finally(() => {
      process.exitCode = 0; // fail-open: the hook never breaks the builder
    });
}
