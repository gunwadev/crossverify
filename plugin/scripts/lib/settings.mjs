// lib/settings.mjs — settings.json Stop-hook merge for the non-plugin install path.
// Trust rules (spec): ADDITIVE merge only, .bak backup before write, never clobber
// existing hooks; removeHook removes only crossverify entries.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function verifierPath() {
  return fileURLToPath(new URL('../verifier.mjs', import.meta.url));
}

// JSON-quote a path only when it contains a space (leaves the common
// no-spaces case unquoted, matching the proven bash reference hook's style).
export function quoteForCommand(p) {
  return p.includes(' ') ? JSON.stringify(p) : p;
}

export function hookCommand() {
  return 'node ' + quoteForCommand(verifierPath());
}

function readSettings(settingsPath) {
  const text = fs.readFileSync(settingsPath, 'utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `settings.json is not valid JSON at ${settingsPath} — fix or restore it (a .bak may exist) before continuing`
    );
  }
}

function writeSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmpPath = `${settingsPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmpPath, settingsPath);
}

export function addHook(settingsPath) {
  let settings = {};
  let backedUp = false;
  if (fs.existsSync(settingsPath)) {
    // Read (and validate) BEFORE touching disk any further — a parse
    // failure throws here and nothing below runs, so a corrupt file is
    // never backed up or overwritten.
    settings = readSettings(settingsPath);
    fs.copyFileSync(settingsPath, settingsPath + '.bak');
    backedUp = true;
  }

  const command = hookCommand();
  if (typeof settings.hooks !== 'object' || settings.hooks === null) {
    settings.hooks = {};
  }
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];

  const alreadyPresent = settings.hooks.Stop.some(
    (entry) =>
      Array.isArray(entry.hooks) &&
      entry.hooks.some((h) => h && h.command === command)
  );

  if (alreadyPresent) {
    // Nothing to change — do NOT rewrite the file, so "left as-is" holds
    // at the byte level, not just semantically.
    return { added: false, backedUp };
  }

  let group = settings.hooks.Stop.find((entry) => entry.matcher === '');
  if (!group) {
    group = { matcher: '', hooks: [] };
    settings.hooks.Stop.push(group);
  }
  if (!Array.isArray(group.hooks)) group.hooks = [];
  // timeout: block-mode verification waits on codex (180s budget); without
  // this, Claude Code's default 60s hook timeout kills the hook mid-verify
  // and failmode=closed silently degrades to open.
  group.hooks.push({ type: 'command', command, timeout: 240 });
  writeSettings(settingsPath, settings);
  return { added: true, backedUp };
}

export function removeHook(settingsPath) {
  if (!fs.existsSync(settingsPath)) return { removed: false, backedUp: false };
  // Read (and validate) BEFORE touching disk any further — a parse
  // failure throws here and nothing below runs.
  const settings = readSettings(settingsPath);
  const command = hookCommand();
  const isOurs = (h) => h && typeof h.command === 'string' && h.command === command;

  let removed = false;
  if (settings.hooks && Array.isArray(settings.hooks.Stop)) {
    for (const entry of settings.hooks.Stop) {
      if (!Array.isArray(entry.hooks)) continue;
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter((h) => !isOurs(h));
      if (entry.hooks.length !== before) removed = true;
    }
    // drop groups we emptied; leave untouched groups alone
    settings.hooks.Stop = settings.hooks.Stop.filter(
      (entry) => !Array.isArray(entry.hooks) || entry.hooks.length > 0
    );
    if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
  }

  if (!removed) return { removed: false, backedUp: false };

  // Back up the untouched on-disk file BEFORE writing the mutated version,
  // same guarantee as addHook.
  fs.copyFileSync(settingsPath, settingsPath + '.bak');
  writeSettings(settingsPath, settings);
  return { removed: true, backedUp: true };
}
