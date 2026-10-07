#!/usr/bin/env node
// crossverify CLI — toggle config, inspect status, read reports, uninstall.
// Node stdlib only. Config precedence and lock semantics: see README
// "Configuration" and lib/config.mjs.

import { existsSync, readFileSync, readdirSync, statSync, rmSync, unlinkSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import {
  GLOBAL_DIR,
  countFailedClaims,
  globalConfPath,
  projectConfPath,
  projectKey,
  resolveConfig,
  setConfKey,
  reportsDir,
  stateDir,
} from './lib/config.mjs';
import { removeHook } from './lib/settings.mjs';
import { createPrompter, StdinClosedError } from './lib/prompt.mjs';

const LOCK_VIOLATION_LINE =
  'enabled=0 ignored: locked by global config (lock=1). Only the user can unlock: crossverify lock off';

function globalSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function printUsage() {
  console.log(`crossverify — cross-vendor verifier for Claude Code

  Usage:
    crossverify on                    Enable verifier for this project
    crossverify off                   Disable verifier for this project
    crossverify global on             Enable verifier globally (all projects)
    crossverify global off            Disable verifier globally
    crossverify output project        Write reports to <project>/.crossverify/
    crossverify output global         Write reports to the global state dir
    crossverify pack <name>           Select a rule pack, e.g. crossverify pack default
    crossverify research on|off       Let the verifier use Codex's web-search tool for external-world claims
    crossverify second on|off         Run a second, independent reviewer (FireRouter via Fireworks) in parallel
    crossverify second setup          Create the second reviewer's Codex home via fireconnect (needs a Fireworks key)
    crossverify second now            Re-verify the last turn right now with the second reviewer, print the report
    crossverify second check          One tiny request to Fireworks: OK / SUSPENDED / RATE LIMITED / KEY REJECTED
                                      (--transcript <path> to pick a transcript; --session <id> to pick a session)
    crossverify gaps on|off           Include a gap analysis (missing/fragile things) in every report (default on)
    crossverify lock on               Lock global config: project conf may enable, never disable
    crossverify lock off              Remove the tamper lock
    crossverify status                Show resolved config and which layer decided each key
    crossverify status --json         Same, as machine-readable JSON
    crossverify report                Show the latest verifier report for this project
    crossverify report --json         Same, as the raw verdict JSON
    crossverify uninstall             Remove the hook, config, and state (asks to confirm)
    crossverify uninstall --yes       Same, without the confirmation prompt
    crossverify help                  Show this message`);
}

function printStatusTable(config) {
  const keys = ['enabled', 'mode', 'output', 'pack', 'research', 'second', 'gaps', 'lock', 'failmode'];
  const rows = keys.map((key) => [
    key,
    String(config[key]),
    (config.decidedBy && config.decidedBy[key]) || 'default',
  ]);
  const keyWidth = Math.max('KEY'.length, ...rows.map((row) => row[0].length));
  const valueWidth = Math.max('VALUE'.length, ...rows.map((row) => row[1].length));
  console.log(`${'KEY'.padEnd(keyWidth)}  ${'VALUE'.padEnd(valueWidth)}  DECIDED BY`);
  for (const [key, value, decidedBy] of rows) {
    console.log(`${key.padEnd(keyWidth)}  ${value.padEnd(valueWidth)}  ${decidedBy}`);
  }
}

// prefix: in the shared global reports dir, only THIS project's files
// (projectKey-prefixed) count — see config.mjs projectKey.
function findNewestJsonReport(dir, prefix = '') {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((name) => name.endsWith('.json') && name.startsWith(prefix));
  let newestPath = null;
  let newestMtimeMs = -Infinity;
  for (const name of files) {
    const fullPath = path.join(dir, name);
    const stats = statSync(fullPath);
    if (stats.mtimeMs > newestMtimeMs) {
      newestMtimeMs = stats.mtimeMs;
      newestPath = fullPath;
    }
  }
  return newestPath;
}

function isLockViolation(notes) {
  return Array.isArray(notes) && notes.some((note) => note.includes('ignored: locked'));
}

function cmdOnOff(enable) {
  const cwd = process.cwd();
  setConfKey('project', 'enabled', enable ? '1' : '0', cwd);
  console.log(
    `crossverify: project enabled=${enable ? '1' : '0'} written to ${projectConfPath(cwd)}`
  );
  if (!enable) {
    const after = resolveConfig({ cwd, env: process.env });
    if (isLockViolation(after.notes)) {
      console.log(LOCK_VIOLATION_LINE);
    }
  }
  process.exit(0);
}

function cmdGlobal(sub) {
  if (sub !== 'on' && sub !== 'off') {
    printUsage();
    process.exit(1);
  }
  const cwd = process.cwd();
  setConfKey('global', 'enabled', sub === 'on' ? '1' : '0', cwd);
  console.log(`crossverify: global enabled=${sub === 'on' ? '1' : '0'} written to ${globalConfPath()}`);
  process.exit(0);
}

function cmdOutput(sub) {
  if (sub !== 'project' && sub !== 'global') {
    printUsage();
    process.exit(1);
  }
  const cwd = process.cwd();
  setConfKey('project', 'output', sub, cwd);
  console.log(`crossverify: project output=${sub} written to ${projectConfPath(cwd)}`);
  process.exit(0);
}

function cmdPack(name) {
  if (!name) {
    printUsage();
    process.exit(1);
  }
  const cwd = process.cwd();
  setConfKey('project', 'pack', name, cwd);
  console.log(`crossverify: project pack=${name} written to ${projectConfPath(cwd)}`);
  process.exit(0);
}

function cmdResearch(sub) {
  if (sub !== 'on' && sub !== 'off') {
    printUsage();
    process.exit(1);
  }
  const cwd = process.cwd();
  setConfKey('project', 'research', sub, cwd);
  console.log(`crossverify: project research=${sub} written to ${projectConfPath(cwd)}`);
  process.exit(0);
}

function secondHomePath() {
  return path.join(stateDir(), 'codex-home-second');
}

// `crossverify second setup`: build a SEPARATE Codex home whose config.toml
// routes through Fireworks (FireRouter), using fireconnect's own Codex
// harness writer so the provider block, key reference and catalog are exactly
// what fireconnect maintains. The hook then runs the second reviewer with
// CODEX_HOME pointed here, leaving the user's real ~/.codex untouched.
function cmdSecondSetup() {
  const model = process.env.CROSSVERIFY_SECOND_MODEL && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(process.env.CROSSVERIFY_SECOND_MODEL)
    ? process.env.CROSSVERIFY_SECOND_MODEL
    : 'firerouter';
  const probe = spawnSync('fireconnect', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.error('crossverify: fireconnect not found on PATH.');
    console.error('Install it (https://github.com/fw-ai/fireconnect), run `fireconnect login`, then re-run `crossverify second setup`.');
    process.exit(1);
  }
  const home = secondHomePath();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const configPath = path.join(home, 'config.toml');
  // --force: fireconnect refuses to write while the ChatGPT desktop app runs,
  // because that app reads the SHARED ~/.codex/config.toml. This config is a
  // separate file under our own state dir that the app never loads, so the
  // guard does not apply here.
  const args = ['codex', 'on', '--model', model, '--config-path', configPath, '--data-dir', path.join(home, 'fireconnect-state'), '--force'];
  const res = spawnSync('fireconnect', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.error || res.status !== 0 || !existsSync(configPath)) {
    if (res.stderr) process.stderr.write(res.stderr);
    console.error(`crossverify: fireconnect codex on failed (exit ${res.status ?? 'spawn error'}); second reviewer not configured.`);
    process.exit(1);
  }
  const cwd = process.cwd();
  setConfKey('project', 'second', 'on', cwd);
  console.log(`crossverify: second reviewer ready — model=${model}, codex home ${home}`);
  console.log(`crossverify: project second=on written to ${projectConfPath(cwd)}`);
  console.log('Override the model with CROSSVERIFY_SECOND_MODEL; check with `crossverify status`.');
  process.exit(0);
}

// Newest Claude Code transcript for this project: ~/.claude/projects/<key>/
// where <key> is the cwd with every non-alphanumeric char replaced by '-'.
function claudeProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function findLatestTranscript(cwd, sessionId) {
  const key = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(claudeProjectsDir(), key);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && (!sessionId || f === `${sessionId}.jsonl`));
  let best = null; let bestM = -Infinity;
  for (const f of files) {
    const full = path.join(dir, f);
    const m = statSync(full).mtimeMs;
    if (m > bestM) { bestM = m; best = full; }
  }
  return best;
}

// `crossverify second now`: run the verifier once, foreground, with the second
// reviewer forced on, against the newest transcript (or --transcript), and
// print the report. Report-only: never blocks, never touches the attempt
// counter. This is how the second reviewer is meant to be used when it is
// too expensive or rate-limited to run on every Stop.
function cmdSecondNow(argv) {
  const cwd = process.cwd();
  const secondConf = path.join(secondHomePath(), 'config.toml');
  if (!existsSync(secondConf)) {
    console.error(`crossverify: no second reviewer configured (missing ${secondConf}). Run \`crossverify second setup\` first.`);
    process.exit(1);
  }
  const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const sessionId = at('--session');
  let transcript = at('--transcript');
  if (!transcript) transcript = findLatestTranscript(cwd, sessionId);
  if (!transcript || !existsSync(transcript)) {
    console.error(`crossverify: no transcript found for this project${sessionId ? ` (session ${sessionId})` : ''}.`);
    console.error(`Looked in: ${path.join(claudeProjectsDir(), path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-'))}`);
    console.error('Pass one explicitly: crossverify second now --transcript <path/to/session.jsonl>');
    process.exit(1);
  }
  const session = sessionId || path.basename(transcript, '.jsonl');
  const verifier = fileURLToPath(new URL('./verifier.mjs', import.meta.url));
  console.log(`crossverify: second reviewer run on ${path.basename(transcript)} (this can take a few minutes)...`);
  const res = spawnSync(process.execPath, [verifier, '--on-demand'], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: session, transcript_path: transcript, stop_hook_active: false, cwd }),
    env: { ...process.env, CROSSVERIFY: process.env.CROSSVERIFY || '1' },
  });
  if (res.error || res.status !== 0) {
    console.error(`crossverify: verifier run failed (${res.error ? res.error.message : `exit ${res.status}`}). See hook.log.`);
    process.exit(1);
  }
  const config = resolveConfig({ cwd, env: process.env });
  const latest = findNewestJsonReport(reportsDir(config, cwd), config.output === 'global' ? `${projectKey(cwd)}-` : '');
  if (!latest || Date.now() - statSync(latest).mtimeMs > 10 * 60 * 1000) {
    console.error('crossverify: no fresh report was written. Check `hook.log` (the run may have been skipped: disabled, or codex missing).');
    process.exit(1);
  }
  cmdReport(['report']);
}

// Read the bits of the second reviewer's config.toml we need for a probe.
// The file is fireconnect's; we only read it (a few fixed keys), never parse
// TOML generally.
function readSecondProvider() {
  const confPath = path.join(secondHomePath(), 'config.toml');
  if (!existsSync(confPath)) return null;
  const text = readFileSync(confPath, 'utf8');
  const pick = (key) => {
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
    return m ? m[1] : undefined;
  };
  return { model: pick('model') || 'firerouter', baseUrl: pick('base_url') || 'https://api.fireworks.ai/inference/v1', key: pick('experimental_bearer_token') };
}

// `crossverify second check`: the smallest possible real request (1 token)
// through the second reviewer's provider, so "is Fireworks working for me"
// has a yes/no answer before a verify run spends minutes finding out.
// Exit 0 = usable, 2 = not usable right now (reason printed), 1 = not set up.
async function cmdSecondCheck() {
  const prov = readSecondProvider();
  if (!prov || !prov.key) {
    console.error('crossverify: second reviewer not configured. Run `crossverify second setup` first.');
    process.exit(1);
  }
  const url = `${prov.baseUrl.replace(/\/$/, '')}/chat/completions`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${prov.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: prov.model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.log(`Fireworks: UNREACHABLE — ${err.message} (${url})`);
    process.exit(2);
  }
  const text = await res.text();
  let msg = '';
  try { msg = JSON.parse(text)?.error?.message || ''; } catch { /* non-JSON body */ }
  if (res.status === 200) {
    let served = '';
    try { served = JSON.parse(text)?.model || ''; } catch { /* ignore */ }
    console.log(`Fireworks: OK — model ${prov.model}${served ? ` served by ${served}` : ''}. The second reviewer can run now.`);
    process.exit(0);
  }
  if (res.status === 412) {
    console.log(`Fireworks: SUSPENDED (HTTP 412) — ${msg || 'account suspended'}`);
    console.log('Fix at https://fireworks.ai/account/billing (spending limit or unpaid invoice). The second reviewer will fail open until then.');
  } else if (res.status === 429) {
    const ra = res.headers.get('retry-after');
    console.log(`Fireworks: RATE LIMITED (HTTP 429)${ra ? ` — retry in ${ra}s` : ''}. ${msg}`.trim());
    console.log('The key is shared with anything else routed through Fireworks on this machine; wait, or run the check again later.');
  } else if (res.status === 401 || res.status === 403) {
    console.log(`Fireworks: KEY REJECTED (HTTP ${res.status}). Run \`fireconnect login\` then \`crossverify second setup\` to re-mint the config.`);
  } else {
    console.log(`Fireworks: HTTP ${res.status} — ${msg || text.slice(0, 200)}`);
  }
  process.exit(2);
}

function cmdSecond(sub, argv) {
  if (sub === 'setup') return cmdSecondSetup();
  if (sub === 'check') return cmdSecondCheck();
  if (sub === 'now') return cmdSecondNow(argv);
  if (sub !== 'on' && sub !== 'off') {
    printUsage();
    process.exit(1);
  }
  const cwd = process.cwd();
  setConfKey('project', 'second', sub, cwd);
  console.log(`crossverify: project second=${sub} written to ${projectConfPath(cwd)}`);
  if (sub === 'on' && !existsSync(path.join(secondHomePath(), 'config.toml'))) {
    console.log('note: no second reviewer codex home yet — run `crossverify second setup` or the hook will skip it (fail-open).');
  }
  process.exit(0);
}

function cmdGaps(sub) {
  if (sub !== 'on' && sub !== 'off') {
    printUsage();
    process.exit(1);
  }
  const cwd = process.cwd();
  setConfKey('project', 'gaps', sub, cwd);
  console.log(`crossverify: project gaps=${sub} written to ${projectConfPath(cwd)}`);
  process.exit(0);
}

function cmdLock(sub) {
  if (sub !== 'on' && sub !== 'off') {
    printUsage();
    process.exit(1);
  }
  const cwd = process.cwd();
  setConfKey('global', 'lock', sub === 'on' ? '1' : '0', cwd);
  console.log(`crossverify: global lock=${sub === 'on' ? '1' : '0'} written to ${globalConfPath()}`);
  process.exit(0);
}

function cmdStatus(argv) {
  const json = argv.includes('--json');
  const config = resolveConfig({ cwd: process.cwd(), env: process.env });
  if (json) {
    console.log(JSON.stringify(config, null, 2));
    process.exit(0);
  }
  printStatusTable(config);
  // "status" must answer "did it actually run?", not just show config —
  // surface the newest report for this project inline.
  const lastReport = findNewestJsonReport(
    reportsDir(config, process.cwd()),
    config.output === 'global' ? `${projectKey(process.cwd())}-` : ''
  );
  if (lastReport) {
    try {
      const v = JSON.parse(readFileSync(lastReport, 'utf8'));
      const ageMin = Math.round((Date.now() - statSync(lastReport).mtimeMs) / 60000);
      const age = ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
      console.log(`\nlast run: ${v.status ?? 'unknown'} (${age}) — crossverify report for details`);
    } catch {
      console.log(`\nlast run: unreadable report at ${lastReport}`);
    }
  } else {
    console.log('\nlast run: none recorded for this project');
  }
  if (config.notes && config.notes.length > 0) {
    console.log('');
    for (const note of config.notes) {
      console.log(`note: ${note}`);
    }
    if (isLockViolation(config.notes)) {
      console.log(LOCK_VIOLATION_LINE);
    }
  }
  process.exit(0);
}

function cmdReport(argv) {
  const json = argv.includes('--json');
  const cwd = process.cwd();
  const config = resolveConfig({ cwd, env: process.env });
  const dir = reportsDir(config, cwd);
  const reportPath = findNewestJsonReport(dir, config.output === 'global' ? `${projectKey(cwd)}-` : '');

  if (!reportPath) {
    if (json) {
      console.log('null');
    } else {
      console.log('No verifier reports found for this project.');
      console.log(`Looked in: ${dir}`);
    }
    process.exit(0);
  }

  const raw = readFileSync(reportPath, 'utf8');
  if (json) {
    console.log(raw.trim());
    process.exit(0);
  }

  let verdict;
  try {
    verdict = JSON.parse(raw);
  } catch {
    console.log(`Latest report is not valid JSON: ${reportPath}`);
    process.exit(0);
  }
  const stats = statSync(reportPath);
  // Colors only on a real terminal; piped output stays plain. Zero deps:
  // raw ANSI, Playwright-reporter-flavored layout.
  const tty = process.stdout.isTTY === true;
  const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  // One terminal line even at narrow widths — wrapped continuations lose the
  // indent and read as noise, so truncate instead.
  const firstSentence = (s) => {
    if (typeof s !== 'string') return '';
    const first = s.split(/(?<=\.) /)[0];
    return first.length > 120 ? `${first.slice(0, 120)}…` : first;
  };
  const status = String(verdict.status ?? 'unknown');
  const statusColor = { verified: '1;32', failed: '1;31' }[status] ?? '1;33';
  const when = stats.mtime.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  console.log();
  console.log(`  ${c('1', 'crossverify')} ${c('2', '·')} ${c(statusColor, status.toUpperCase())}   ${c('2', `${path.basename(reportPath)} · ${when}`)}`);
  console.log();
  const rows = [
    ...(Array.isArray(verdict.verified) ? verdict.verified : []).map((x) => ['32', '✓', x]),
    ...(Array.isArray(verdict.failed) ? verdict.failed : []).map((x) => ['31', '✗', x]),
    ...(Array.isArray(verdict.could_not_verify) ? verdict.could_not_verify : []).map((x) => ['33', '?', x]),
  ].filter(([, , x]) => x && typeof x.claim === 'string');
  for (const [code, mark, x] of rows) {
    console.log(`  ${c(code, mark)} ${x.claim}`);
    const detail = firstSentence(x.evidence ?? x.reason);
    if (detail) console.log(`      ${c('2', `└ ${detail}`)}`);
  }
  if (rows.length) console.log();
  const gaps = (Array.isArray(verdict.gaps) ? verdict.gaps : []).filter((g) => g && typeof g.gap === 'string');
  for (const g of gaps) {
    console.log(`  ${c('35', '!')} ${c('35', g.classification ?? 'GAP')} ${g.gap}`);
    const detail = [firstSentence(g.evidence), g.fix ? `fix: ${firstSentence(g.fix)}` : ''].filter(Boolean).join(' · ');
    if (detail) console.log(`      ${c('2', `└ ${detail}`)}`);
  }
  if (gaps.length) console.log();
  const nv = (verdict.verified ?? []).length, nf = countFailedClaims(verdict), nu = (verdict.could_not_verify ?? []).length;
  console.log(`  ${c('32', `${nv} verified`)} ${c('2', '·')} ${c(nf ? '31' : '2', `${nf} failed`)} ${c('2', '·')} ${c(nu ? '33' : '2', `${nu} unverified`)}${gaps.length ? ` ${c('2', '·')} ${c('35', `${gaps.length} gap${gaps.length === 1 ? '' : 's'}`)}` : ''}`);
  if (verdict.second && typeof verdict.second === 'object') {
    const sec = verdict.second;
    const tail = sec.status === 'error' ? `error: ${firstSentence(sec.error)}`
      : sec.promoted ? `(stands alone: primary failed: ${firstSentence(verdict.primary_error)})${sec.hollow ? ' — HOLLOW: inspected nothing, treat as no verdict' : ''}`
        : (sec.agreed ? '(agrees)' : '(disagrees)');
    console.log(`  ${c('2', `second reviewer ${sec.model ?? '?'}: ${sec.status ?? '?'} ${tail}`)}`);
  }
  console.log();
  if (status === 'failed') console.log(`  ${c('1;31', '■ BLOCK')} — builder was sent the failed claims as feedback`);
  else if (status === 'verified') console.log(`  ${c('1;32', '■ PASS')} — all claims verified`);
  else console.log(`  ${c('1;33', `■ ${status.toUpperCase()}`)}`);
  console.log(`  ${c('2', '→ crossverify report --json for the full verdict')}`);
  console.log();
  process.exit(0);
}

async function cmdUninstall(argv) {
  const skipConfirm = argv.includes('--yes');
  const settingsPath = globalSettingsPath();

  const toRemove = [];
  const confPath = globalConfPath();
  if (existsSync(confPath)) toRemove.push(confPath);
  const sDir = stateDir();
  if (existsSync(sDir)) toRemove.push(sDir);
  if (existsSync(GLOBAL_DIR) && GLOBAL_DIR !== sDir && !toRemove.includes(GLOBAL_DIR)) {
    toRemove.push(GLOBAL_DIR);
  }

  console.log('crossverify uninstall will remove:');
  console.log(`  - Stop hook entry in ${settingsPath}`);
  for (const target of toRemove) {
    console.log(`  - ${target}`);
  }
  if (toRemove.length === 0) {
    console.log('  (no config or state directories found — only the hook entry will be touched)');
  }
  console.log('Project-level files are NOT removed: delete .claude/crossverify.conf and .crossverify/ per project if wanted.');

  if (!skipConfirm) {
    const prompter = createPrompter();
    let answer;
    try {
      answer = await prompter.ask('Proceed? [y/N] ');
    } catch (err) {
      prompter.close();
      if (err instanceof StdinClosedError) {
        console.log('Aborted. Nothing was removed. (use --yes non-interactively)');
        process.exit(1);
      }
      throw err;
    }
    prompter.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Aborted. Nothing was removed.');
      process.exit(0);
    }
  }

  const hookResult = removeHook(settingsPath);
  console.log(hookResult.removed
    ? `Removed Stop hook entry from ${settingsPath}`
    : `No Stop hook entry in ${settingsPath} (plugin installs keep theirs in hooks.json) — nothing to remove there.`);

  for (const target of toRemove) {
    if (!existsSync(target)) continue;
    const stats = statSync(target);
    if (stats.isDirectory()) {
      rmSync(target, { recursive: true, force: true });
    } else {
      unlinkSync(target);
    }
    console.log(`Removed ${target}`);
  }

  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd) {
    printUsage();
    process.exit(1);
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printUsage();
    process.exit(0);
  }

  switch (cmd) {
    case 'on':
      cmdOnOff(true);
      break;
    case 'off':
      cmdOnOff(false);
      break;
    case 'global':
      cmdGlobal(argv[1]);
      break;
    case 'output':
      cmdOutput(argv[1]);
      break;
    case 'pack':
      cmdPack(argv[1]);
      break;
    case 'research':
      cmdResearch(argv[1]);
      break;
    case 'second':
      cmdSecond(argv[1], argv.slice(2));
      break;
    case 'gaps':
      cmdGaps(argv[1]);
      break;
    case 'lock':
      cmdLock(argv[1]);
      break;
    case 'status':
      cmdStatus(argv);
      break;
    case 'report':
      cmdReport(argv);
      break;
    case 'uninstall':
      await cmdUninstall(argv);
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`crossverify: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
