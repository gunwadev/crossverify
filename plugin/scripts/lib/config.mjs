// crossverify config resolution — Node stdlib only, zero deps.
// Precedence per key: env > project conf > global conf > default.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GLOBAL_DIR = path.join(os.homedir(), '.claude', 'crossverify');

export function globalConfPath() {
  return path.join(GLOBAL_DIR, 'config');
}

export function projectConfPath(cwd) {
  return path.join(cwd, '.claude', 'crossverify.conf');
}

export function parseConf(text) {
  const map = new Map();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === '') continue;
    map.set(key, value);
  }
  return map;
}

const DEFAULTS = {
  enabled: false,
  mode: 'background',
  output: 'project',
  pack: 'default',
  research: 'off',
  lock: false,
  failmode: 'open',
};

const ENUMS = {
  mode: ['background', 'foreground'],
  output: ['project', 'global'],
  research: ['off', 'on'],
  failmode: ['open', 'closed'],
};

// Keys whose value is a bare NAME, not free text. `pack` becomes a path
// segment (verifier.mjs joins it into the plugin's rules dir), so an
// unvalidated value is a path-traversal primitive: a project conf saying
// pack=../../../repo/evil made the hook stage a rule pack the builder wrote
// itself, which is the whole verifier defeated by one line of config.
const NAMES = {
  pack: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
};

function readConfFile(confPath) {
  let text;
  try {
    text = fs.readFileSync(confPath, 'utf8');
  } catch {
    return new Map();
  }
  return parseConf(text);
}

export function resolveConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const config = { ...DEFAULTS };
  const decidedBy = {};
  for (const key of Object.keys(DEFAULTS)) decidedBy[key] = 'default';
  const notes = [];

  const applyValue = (key, raw, layer) => {
    if (key === 'enabled' || key === 'lock') {
      config[key] = raw === '1';
    } else if (ENUMS[key] && !ENUMS[key].includes(raw)) {
      notes.push(`invalid ${key}=${raw} from ${layer} ignored`);
      return;
    } else if (NAMES[key] && !NAMES[key].test(raw)) {
      notes.push(`invalid ${key}=${raw} from ${layer} ignored (not a bare name)`);
      return;
    } else {
      config[key] = raw;
    }
    decidedBy[key] = layer;
  };

  // Layer: global conf (the only layer allowed to set lock).
  const globalConf = readConfFile(globalConfPath());
  for (const key of Object.keys(DEFAULTS)) {
    if (globalConf.has(key)) applyValue(key, globalConf.get(key), 'global');
  }

  const projectConf = readConfFile(projectConfPath(cwd));

  // Layer: project conf. lock is global-only; enabled=0 is a project
  // disable and is gated by the global tamper lock — never silent.
  // The lock also gates enforcement DOWNGRADES: a builder that writes
  // mode=background (when foreground is in effect) or failmode=open (when
  // closed is in effect) into the project conf would silently defang blocking
  // while `enabled` still reads 1 — treat that exactly like a disable.
  // Upgrades (background->foreground, open->closed) are always allowed.
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'lock' || !projectConf.has(key)) continue;
    const raw = projectConf.get(key);
    if (key === 'enabled' && raw !== '1') {
      if (config.lock) {
        notes.push('project disable ignored: locked');
      } else {
        config.enabled = false;
        decidedBy.enabled = 'project';
        notes.push('project disable honored (lock off)');
      }
      continue;
    }
    // A locked config pins the rule pack too. Swapping packs rewrites what
    // "failed" even means, so it is an enforcement downgrade in everything but
    // name — and unlike mode/failmode it leaves `enabled` reading 1.
    if (key === 'pack' && config.lock && raw !== config.pack) {
      notes.push(`project pack=${raw} ignored: locked`);
      continue;
    }
    const isDowngrade = (key === 'mode' && raw === 'background' && config.mode === 'foreground')
      || (key === 'failmode' && raw === 'open' && config.failmode === 'closed');
    if (isDowngrade) {
      if (config.lock) {
        notes.push(`project ${key}=${raw} downgrade ignored: locked`);
        continue;
      }
      notes.push(`project ${key}=${raw} downgrade honored (lock off)`);
    }
    applyValue(key, raw, 'project');
  }

  // Layer: env.
  const envRaw = env.CROSSVERIFY;
  if (envRaw !== undefined && envRaw !== '') {
    if (envRaw === '0') {
      // The lock gates the env layer too. Project settings files can set env
      // vars for hook processes, so an ungated CROSSVERIFY=0 was a
      // project-level bypass of the one thing the lock promises. Either way
      // this is never silent — an invisible disable is the real defect.
      if (config.lock) {
        notes.push('env CROSSVERIFY=0 ignored: locked');
      } else {
        config.enabled = false;
        decidedBy.enabled = 'env';
        notes.push('env disable honored (lock off)');
      }
    } else if (envRaw === '1') {
      config.enabled = true;
      decidedBy.enabled = 'env';
    } else if (envRaw === 'foreground') {
      config.enabled = true;
      config.mode = 'foreground';
      decidedBy.enabled = 'env';
      decidedBy.mode = 'env';
    } else if (envRaw === 'force') {
      config.enabled = true;
      config.mode = 'foreground';
      decidedBy.enabled = 'env';
      decidedBy.mode = 'env';
      notes.push('env force: disable gates bypassed');
    } else {
      notes.push(`unknown env value ${envRaw} ignored`);
    }
  }

  return { ...config, decidedBy, notes };
}

export function setConfKey(scope, key, value, cwd = process.cwd()) {
  const confPath = scope === 'global' ? globalConfPath() : projectConfPath(cwd);
  fs.mkdirSync(path.dirname(confPath), { recursive: true });
  let text = '';
  try {
    text = fs.readFileSync(confPath, 'utf8');
  } catch {
    // new file
  }
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let replaced = false;
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    const lineKey = trimmed.startsWith('#') || eq === -1
      ? null
      : trimmed.slice(0, eq).trim();
    if (lineKey !== key) {
      out.push(line);
    } else if (!replaced) {
      out.push(`${key}=${value}`);
      replaced = true;
    }
    // duplicate lines for the same key are dropped
  }
  if (!replaced) out.push(`${key}=${value}`);
  fs.writeFileSync(confPath, out.join('\n') + '\n');
  return confPath;
}

// v1 decision: state always lives under ~/.claude/crossverify, for the hook
// and the CLI alike. CLAUDE_PLUGIN_DATA (a separate per-plugin data dir on
// plugin installs) is deferred to v2 — supporting it created a hook-vs-CLI
// state-dir divergence: the Stop hook (which does see CLAUDE_PLUGIN_DATA)
// and a shell-invoked `crossverify` command (which does not) would resolve
// two different state directories for the same install.
export function stateDir() {
  return GLOBAL_DIR;
}

// Stable per-project discriminator for the SHARED global reports dir: without
// it, `crossverify report` and the statusline would surface another project's
// newest verdict as if it were this one — a misattributed answer from a
// verifier is a wrong answer. Project-local dirs don't need it.
export function projectKey(cwd = process.cwd()) {
  // realpath: the hook's cwd and a shell's process.cwd() can disagree through
  // symlinks (macOS /tmp -> /private/tmp, symlinked project dirs) — writer and
  // reader must derive the same key for the same project.
  let resolved = path.resolve(cwd);
  try { resolved = fs.realpathSync(resolved); } catch { /* keep resolved */ }
  return createHash('sha256').update(resolved).digest('hex').slice(0, 8);
}

export function reportsDir(config, cwd = process.cwd()) {
  if (config && config.output === 'global') {
    return path.join(stateDir(), 'reports');
  }
  return path.join(cwd, '.crossverify');
}

// Shared by cli.mjs and statusline-segment.mjs (the statusline script runs
// main() on import, so it cannot be imported from — the helper lives here).
export function countFailedClaims(verdict) {
  if (typeof verdict.claims_failed === 'number') return verdict.claims_failed;
  if (Array.isArray(verdict.claims)) {
    return verdict.claims.filter((claim) => claim && claim.status === 'failed').length;
  }
  return 0;
}

export function logPath() {
  return path.join(stateDir(), 'hook.log');
}

// 0700/0600: the log records project paths and codex stderr tails, and the
// state dir sits beside reports carrying transcript content. On a shared host
// the default umask would leave both readable by every local user.
export function log(msg) {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(logPath(), `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
}
