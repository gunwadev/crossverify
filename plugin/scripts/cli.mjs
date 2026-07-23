#!/usr/bin/env node
// crossverify CLI — toggle config, inspect status, read reports, uninstall.
// Node stdlib only. Config precedence and lock semantics: see README
// "Configuration" and lib/config.mjs.

import { existsSync, readFileSync, readdirSync, statSync, rmSync, unlinkSync } from 'node:fs';
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
  const keys = ['enabled', 'mode', 'output', 'pack', 'research', 'lock', 'failmode'];
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
  console.log(`crossverify report — ${reportPath}`);
  console.log(`status:         ${verdict.status ?? 'unknown'}`);
  console.log(`claims_failed:  ${countFailedClaims(verdict)}`);
  console.log(`generated:      ${stats.mtime.toISOString()}`);
  console.log('Run "crossverify report --json" for the full verdict.');
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
