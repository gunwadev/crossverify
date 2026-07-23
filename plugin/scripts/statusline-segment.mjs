#!/usr/bin/env node
// crossverify statusline segment — prints [VFY ...] or nothing. Never fails the prompt.

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { countFailedClaims, projectKey, resolveConfig, reportsDir } from './lib/config.mjs';

const RUNNING_WINDOW_MS = 3 * 60 * 1000;

function listFilesByMtimeDesc(dir) {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of entries) {
    const fullPath = path.join(dir, name);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    files.push({ path: fullPath, name, mtimeMs: stats.mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

// Walk newest -> oldest until a meaningful file decides the segment. A loop,
// NOT recursion: recursing after a failed stale-marker delete (Windows AV /
// permission lock) would re-encounter the same marker forever and hang the
// prompt. Staged verify inputs (.turn.jsonl / .rules.md / .raw.txt) are
// skipped rather than blanking the segment mid-run.
// prefix: in the shared global reports dir, only THIS project's
// (projectKey-prefixed) files may decide the segment — another project's
// verdict shown here would be a wrong answer.
function segmentForDir(dir, prefix = '') {
  for (const file of listFilesByMtimeDesc(dir)) {
    if (prefix && !file.name.startsWith(prefix)) continue;
    if (file.name.endsWith('.running')) {
      const age = Date.now() - file.mtimeMs;
      if (age < RUNNING_WINDOW_MS) return '[VFY …]';
      // Stale marker — a background verify that crashed or was killed never
      // got to clean it up. Best-effort delete; either way keep walking to
      // whatever the next-newest file (likely an actual report) says.
      try { unlinkSync(file.path); } catch { /* best effort */ }
      continue;
    }

    if (file.name.endsWith('.json')) {
      let verdict;
      try {
        verdict = JSON.parse(readFileSync(file.path, 'utf8'));
      } catch {
        return null;
      }
      if (verdict.status === 'verified') return '[VFY ✓]';
      if (verdict.status === 'failed') return `[VFY ✗ fix:${countFailedClaims(verdict)}]`;
      return null;
    }

    // Staged inputs and raw archives never decide the segment — skip.
  }
  return null;
}

function main() {
  const cwd = process.cwd();
  const config = resolveConfig({ cwd, env: process.env });

  const projectDir = reportsDir({ ...config, output: 'project' }, cwd);
  let segment = segmentForDir(projectDir);

  if (!segment) {
    const globalDir = reportsDir({ ...config, output: 'global' }, cwd);
    if (globalDir !== projectDir) {
      segment = segmentForDir(globalDir, `${projectKey(cwd)}-`);
    }
  }

  if (segment) {
    process.stdout.write(segment);
  }
}

try {
  main();
} catch {
  // statusline must never break the prompt
}
process.exit(0);
