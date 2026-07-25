import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point homedir at a temp dir BEFORE importing the module under test,
// so GLOBAL_DIR resolves inside the sandbox (os.homedir() reads
// HOME on POSIX, USERPROFILE on Windows).
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crossverify-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CROSSVERIFY;

const cfg = await import('../plugin/scripts/lib/config.mjs');

// ---- helpers ----

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crossverify-proj-'));
}

function writeGlobalConf(text) {
  fs.mkdirSync(path.dirname(cfg.globalConfPath()), { recursive: true });
  fs.writeFileSync(cfg.globalConfPath(), text);
}

function writeProjectConf(cwd, text) {
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(cfg.projectConfPath(cwd), text);
}

beforeEach(() => {
  fs.rmSync(cfg.globalConfPath(), { force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

// ---- cycle 1: parseConf, paths, defaults ----

test('parseConf parses key=value, skips comments and blanks, trims', () => {
  const m = cfg.parseConf('# comment\n\nenabled = 1\npack=security-audit\nmodel=gpt=5\nnoequals\n');
  assert.equal(m.get('enabled'), '1');
  assert.equal(m.get('pack'), 'security-audit');
  assert.equal(m.get('model'), 'gpt=5'); // only first = splits
  assert.equal(m.has('noequals'), false);
  assert.equal(m.size, 3);
});

test('parseConf: last duplicate wins, CRLF tolerated', () => {
  const m = cfg.parseConf('enabled=0\r\nenabled=1\r\n');
  assert.equal(m.get('enabled'), '1');
});

test('conf paths derive from GLOBAL_DIR and cwd', () => {
  assert.ok(cfg.GLOBAL_DIR.startsWith(FAKE_HOME));
  assert.equal(cfg.GLOBAL_DIR, path.join(os.homedir(), '.claude', 'crossverify'));
  assert.equal(cfg.globalConfPath(), path.join(cfg.GLOBAL_DIR, 'config'));
  const cwd = makeProject();
  assert.equal(cfg.projectConfPath(cwd), path.join(cwd, '.claude', 'crossverify.conf'));
});

test('resolveConfig: everything defaults, default OFF', () => {
  const r = cfg.resolveConfig({ cwd: makeProject(), env: {} });
  assert.equal(r.enabled, false);
  assert.equal(r.mode, 'background');
  assert.equal(r.output, 'project');
  assert.equal(r.pack, 'default');
  assert.equal(r.research, 'off');
  assert.equal(r.lock, false);
  assert.equal(r.failmode, 'open');
  assert.deepEqual(r.decidedBy, {
    enabled: 'default',
    mode: 'default',
    output: 'default',
    pack: 'default',
    research: 'default',
    lock: 'default',
    failmode: 'default',
  });
  assert.deepEqual(r.notes, []);
});

// ---- cycle 2: global/project layering ----

test('global enabled=1 turns on, decidedBy global', () => {
  writeGlobalConf('enabled=1\n');
  const r = cfg.resolveConfig({ cwd: makeProject(), env: {} });
  assert.equal(r.enabled, true);
  assert.equal(r.decidedBy.enabled, 'global');
});

test('project enabled=0 overrides global enabled=1 (lock off) and is noted', () => {
  writeGlobalConf('enabled=1\n');
  const cwd = makeProject();
  writeProjectConf(cwd, 'enabled=0\n');
  const r = cfg.resolveConfig({ cwd, env: {} });
  assert.equal(r.enabled, false);
  assert.equal(r.decidedBy.enabled, 'project');
  assert.ok(r.notes.some((n) => n.includes('disable honored')));
});

test('project enabled=1 overrides global off', () => {
  const cwd = makeProject();
  writeProjectConf(cwd, 'enabled=1\n');
  const r = cfg.resolveConfig({ cwd, env: {} });
  assert.equal(r.enabled, true);
  assert.equal(r.decidedBy.enabled, 'project');
});

test('precedence is per key, not per file', () => {
  writeGlobalConf('enabled=1\npack=security\nfailmode=closed\n');
  const cwd = makeProject();
  writeProjectConf(cwd, 'mode=foreground\noutput=global\n');
  const r = cfg.resolveConfig({ cwd, env: {} });
  assert.equal(r.pack, 'security');
  assert.equal(r.failmode, 'closed');
  assert.equal(r.mode, 'foreground');
  assert.equal(r.output, 'global');
  assert.equal(r.decidedBy.pack, 'global');
  assert.equal(r.decidedBy.failmode, 'global');
  assert.equal(r.decidedBy.mode, 'project');
  assert.equal(r.decidedBy.output, 'project');
});

test('lock is global-only: project lock=1 is ignored', () => {
  const cwd = makeProject();
  writeProjectConf(cwd, 'lock=1\n');
  const r = cfg.resolveConfig({ cwd, env: {} });
  assert.equal(r.lock, false);
  assert.equal(r.decidedBy.lock, 'default');
});

// ---- cycle 3: tamper lock + env ----

test('global lock=1: project enabled=0 ignored, exact note pushed', () => {
  writeGlobalConf('enabled=1\nlock=1\n');
  const cwd = makeProject();
  writeProjectConf(cwd, 'enabled=0\n');
  const r = cfg.resolveConfig({ cwd, env: {} });
  assert.equal(r.enabled, true);
  assert.equal(r.lock, true);
  assert.equal(r.decidedBy.enabled, 'global');
  assert.ok(r.notes.includes('project disable ignored: locked'));
});

test('locked project may still enable', () => {
  writeGlobalConf('lock=1\n');
  const cwd = makeProject();
  writeProjectConf(cwd, 'enabled=1\n');
  const r = cfg.resolveConfig({ cwd, env: {} });
  assert.equal(r.enabled, true);
  assert.equal(r.decidedBy.enabled, 'project');
});

test('CROSSVERIFY=0 disables over global on, decidedBy env', () => {
  writeGlobalConf('enabled=1\n');
  const r = cfg.resolveConfig({ cwd: makeProject(), env: { CROSSVERIFY: '0' } });
  assert.equal(r.enabled, false);
  assert.equal(r.decidedBy.enabled, 'env');
});

test('CROSSVERIFY=1 enables, mode untouched', () => {
  const r = cfg.resolveConfig({ cwd: makeProject(), env: { CROSSVERIFY: '1' } });
  assert.equal(r.enabled, true);
  assert.equal(r.decidedBy.enabled, 'env');
  assert.equal(r.mode, 'background');
  assert.equal(r.decidedBy.mode, 'default');
});

test('CROSSVERIFY=foreground enables and forces mode foreground', () => {
  const r = cfg.resolveConfig({ cwd: makeProject(), env: { CROSSVERIFY: 'foreground' } });
  assert.equal(r.enabled, true);
  assert.equal(r.mode, 'foreground');
  assert.equal(r.decidedBy.mode, 'env');
});

test('CROSSVERIFY=force bypasses project disable', () => {
  const cwd = makeProject();
  writeProjectConf(cwd, 'enabled=0\n');
  const r = cfg.resolveConfig({ cwd, env: { CROSSVERIFY: 'force' } });
  assert.equal(r.enabled, true);
  assert.equal(r.mode, 'foreground');
  assert.equal(r.decidedBy.enabled, 'env');
  assert.ok(r.notes.some((n) => n.includes('force')));
});

// ---- cycle 5: setConfKey, reportsDir/stateDir/logPath/log ----

test('setConfKey creates file with parent dirs and round-trips', () => {
  const cwd = makeProject();
  const written = cfg.setConfKey('project', 'enabled', '1', cwd);
  assert.equal(written, cfg.projectConfPath(cwd));
  assert.equal(cfg.resolveConfig({ cwd, env: {} }).enabled, true);
  cfg.setConfKey('project', 'enabled', '0', cwd);
  const text = fs.readFileSync(written, 'utf8');
  assert.equal(text.match(/^enabled=/gm).length, 1); // replaced, not appended
  assert.equal(cfg.resolveConfig({ cwd, env: {} }).enabled, false);
});

test('setConfKey preserves other lines, comments, and order', () => {
  const cwd = makeProject();
  writeProjectConf(cwd, '# my conf\npack=web\nmode=foreground\n');
  cfg.setConfKey('project', 'mode', 'background', cwd);
  const lines = fs.readFileSync(cfg.projectConfPath(cwd), 'utf8').trimEnd().split('\n');
  assert.deepEqual(lines, ['# my conf', 'pack=web', 'mode=background']);
  cfg.setConfKey('project', 'output', 'global', cwd);
  const lines2 = fs.readFileSync(cfg.projectConfPath(cwd), 'utf8').trimEnd().split('\n');
  assert.deepEqual(lines2, ['# my conf', 'pack=web', 'mode=background', 'output=global']);
});

test('setConfKey global scope writes the global config', () => {
  cfg.setConfKey('global', 'lock', '1');
  assert.equal(fs.readFileSync(cfg.globalConfPath(), 'utf8'), 'lock=1\n');
  assert.equal(cfg.resolveConfig({ cwd: makeProject(), env: {} }).lock, true);
});

test('reportsDir + stateDir + logPath resolution', () => {
  const cwd = makeProject();
  assert.equal(cfg.reportsDir({ output: 'project' }, cwd), path.join(cwd, '.crossverify'));
  assert.equal(cfg.stateDir(), cfg.GLOBAL_DIR);
  assert.equal(cfg.reportsDir({ output: 'global' }, cwd), path.join(cfg.GLOBAL_DIR, 'reports'));
  // v1 decision: CLAUDE_PLUGIN_DATA is no longer consulted — state always
  // resolves to ~/.claude/crossverify regardless of this env var, so the
  // hook (which sees CLAUDE_PLUGIN_DATA on plugin installs) and the CLI
  // (invoked from a shell, which does not) can never disagree about where
  // state lives. Support is deferred to v2.
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), 'crossverify-data-'));
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    assert.equal(cfg.stateDir(), cfg.GLOBAL_DIR);
    assert.equal(cfg.reportsDir({ output: 'global' }, cwd), path.join(cfg.GLOBAL_DIR, 'reports'));
    assert.equal(cfg.logPath(), path.join(cfg.GLOBAL_DIR, 'hook.log'));
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

test('log appends timestamped lines and creates the state dir', () => {
  // Isolate from other tests in this file: they all share FAKE_HOME (and
  // therefore GLOBAL_DIR/hook.log), so start from a clean log file.
  fs.rmSync(cfg.logPath(), { force: true });
  cfg.log('first message');
  cfg.log('second message');
  const lines = fs.readFileSync(cfg.logPath(), 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z first message$/);
  assert.match(lines[1], / second message$/);
});

// ---- lock gates enforcement downgrades (mode/failmode), not just enabled ----

test('lock gates project mode downgrade foreground->background', () => {
  writeGlobalConf('enabled=1\nmode=foreground\nlock=1\n');
  const cwd = makeProject();
  writeProjectConf(cwd, 'mode=background\n');
  const r = cfg.resolveConfig({ cwd, env: {} });
  assert.equal(r.mode, 'foreground');
  assert.equal(r.decidedBy.mode, 'global');
  assert.ok(r.notes.includes('project mode=background downgrade ignored: locked'));
});

test('lock gates project failmode downgrade closed->open', () => {
  writeGlobalConf('enabled=1\nfailmode=closed\nlock=1\n');
  const cwd = makeProject();
  writeProjectConf(cwd, 'failmode=open\n');
  const r = cfg.resolveConfig({ cwd, env: {} });
  assert.equal(r.failmode, 'closed');
  assert.ok(r.notes.includes('project failmode=open downgrade ignored: locked'));
});

test('lock still allows project upgrades background->block and open->closed', () => {
  writeGlobalConf('enabled=1\nlock=1\n');
  const cwd = makeProject();
  writeProjectConf(cwd, 'mode=foreground\nfailmode=closed\n');
  const r = cfg.resolveConfig({ cwd, env: {} });
  assert.equal(r.mode, 'foreground');
  assert.equal(r.failmode, 'closed');
  assert.equal(r.decidedBy.mode, 'project');
  assert.equal(r.decidedBy.failmode, 'project');
});

test('mode downgrade honored with a note when lock off (never silent)', () => {
  writeGlobalConf('enabled=1\nmode=foreground\n');
  const cwd = makeProject();
  writeProjectConf(cwd, 'mode=background\n');
  const r = cfg.resolveConfig({ cwd, env: {} });
  assert.equal(r.mode, 'background');
  assert.equal(r.decidedBy.mode, 'project');
  assert.ok(r.notes.includes('project mode=background downgrade honored (lock off)'));
});

test('research: off by default, on honored from project conf, junk rejected', () => {
  const cwd = makeProject();
  assert.equal(cfg.resolveConfig({ cwd, env: {} }).research, 'off');
  writeProjectConf(cwd, 'research=on\n');
  const r = cfg.resolveConfig({ cwd, env: {} });
  assert.equal(r.research, 'on');
  assert.equal(r.decidedBy.research, 'project');
  writeProjectConf(cwd, 'research=yolo\n');
  const r2 = cfg.resolveConfig({ cwd, env: {} });
  assert.equal(r2.research, 'off');
  assert.ok(r2.notes.some((n) => n.includes('invalid research=yolo')));
});

// ---- security regressions ----

// `pack` becomes a path segment in verifier.mjs. Unvalidated, a project conf
// could point the verifier at a rule pack the builder wrote itself — the
// verifier defeated by one config line, and NOT gated by the tamper lock.
test('security: traversing pack= is rejected and falls back to default', () => {
  const cwd = makeProject();
  for (const evil of [
    '../../../../tmp/evil-rules',
    '..\\..\\evil',
    '/etc/passwd',
    'foo/bar',
    '.',
    '..',
  ]) {
    writeProjectConf(cwd, `pack=${evil}\n`);
    const r = cfg.resolveConfig({ cwd, env: {} });
    assert.equal(r.pack, 'default', `pack=${evil} must not be accepted`);
    assert.equal(r.decidedBy.pack, 'default');
    assert.ok(
      r.notes.some((n) => n.includes('not a bare name')),
      `pack=${evil} rejection must be noted`
    );
  }
});

test('security: ordinary pack names still work', () => {
  const cwd = makeProject();
  for (const ok of ['security', 'web-strict', 'team_pack', 'pack.v2', 'a']) {
    writeProjectConf(cwd, `pack=${ok}\n`);
    const r = cfg.resolveConfig({ cwd, env: {} });
    assert.equal(r.pack, ok);
    assert.equal(r.decidedBy.pack, 'project');
  }
});

test('security: lock pins the rule pack against a project switch', () => {
  writeGlobalConf('enabled=1\nlock=1\npack=strict\n');
  const cwd = makeProject();
  writeProjectConf(cwd, 'pack=lenient\n');
  const r = cfg.resolveConfig({ cwd, env: {} });
  assert.equal(r.pack, 'strict');
  assert.equal(r.decidedBy.pack, 'global');
  assert.ok(r.notes.some((n) => n.includes('project pack=lenient ignored: locked')));
});

// A project settings file can set env vars for hook processes, so an ungated
// CROSSVERIFY=0 was a project-level way around the lock.
test('security: lock gates CROSSVERIFY=0, and the disable is never silent', () => {
  writeGlobalConf('enabled=1\nlock=1\n');
  const cwd = makeProject();
  const locked = cfg.resolveConfig({ cwd, env: { CROSSVERIFY: '0' } });
  assert.equal(locked.enabled, true, 'locked config must ignore an env disable');
  assert.ok(locked.notes.some((n) => n.includes('env CROSSVERIFY=0 ignored: locked')));

  writeGlobalConf('enabled=1\n');
  const unlocked = cfg.resolveConfig({ cwd, env: { CROSSVERIFY: '0' } });
  assert.equal(unlocked.enabled, false, 'without the lock, env still disables');
  assert.equal(unlocked.decidedBy.enabled, 'env');
  assert.ok(unlocked.notes.some((n) => n.includes('env disable honored')));
});

test('security: CROSSVERIFY=force still overrides a locked config', () => {
  writeGlobalConf('enabled=0\nlock=1\n');
  const r = cfg.resolveConfig({ cwd: makeProject(), env: { CROSSVERIFY: 'force' } });
  assert.equal(r.enabled, true);
  assert.equal(r.mode, 'foreground');
});
