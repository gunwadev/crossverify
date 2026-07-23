import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hookCommand, addHook, removeHook, quoteForCommand } from '../plugin/scripts/lib/settings.mjs';
import { installFakeCodex, fakePathEntries } from './helpers/fake-codex.mjs';

function tmpSettings(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossverify-settings-'));
  const settingsPath = path.join(dir, 'settings.json');
  if (initial !== undefined) {
    fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2) + '\n');
  }
  return settingsPath;
}

function existingSettings() {
  return {
    model: 'opus',
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: 'echo unrelated-stop-hook' }],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'echo unrelated-pre-hook' }],
        },
      ],
    },
  };
}

function stopCommands(settings) {
  return (settings.hooks?.Stop ?? []).flatMap((entry) =>
    (entry.hooks ?? []).map((h) => h.command)
  );
}

test('hookCommand is "node <abs verifier.mjs>", quoted iff spaces', () => {
  const cmd = hookCommand();
  assert.ok(cmd.startsWith('node '), `expected "node " prefix, got: ${cmd}`);
  let p = cmd.slice('node '.length);
  if (p.startsWith('"')) {
    p = JSON.parse(p); // JSON-quoted form must round-trip
  } else {
    assert.ok(!p.includes(' '), 'unquoted path must not contain spaces');
  }
  assert.ok(path.isAbsolute(p), `expected absolute path, got: ${p}`);
  assert.ok(
    p.endsWith(path.join('plugin', 'scripts', 'verifier.mjs')),
    `expected path ending in plugin/scripts/verifier.mjs, got: ${p}`
  );
});

test('quoteForCommand: no spaces -> returned unquoted', () => {
  assert.equal(quoteForCommand('/opt/repo/plugin/scripts/verifier.mjs'), '/opt/repo/plugin/scripts/verifier.mjs');
});

test('quoteForCommand: spaces -> JSON-quoted and round-trips', () => {
  const p = '/Users/me/My Repo/plugin/scripts/verifier.mjs';
  const quoted = quoteForCommand(p);
  assert.ok(quoted.startsWith('"') && quoted.endsWith('"'));
  assert.equal(JSON.parse(quoted), p);
});

test('addHook preserves existing hooks, appends ours, writes .bak', () => {
  const settingsPath = tmpSettings(existingSettings());
  const result = addHook(settingsPath);
  assert.equal(result.added, true);
  assert.equal(result.backedUp, true);

  // backup exists and matches the pre-merge content
  assert.ok(fs.existsSync(settingsPath + '.bak'));
  const bak = JSON.parse(fs.readFileSync(settingsPath + '.bak', 'utf8'));
  assert.deepEqual(bak, existingSettings());

  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  // unrelated keys and hooks preserved
  assert.equal(after.model, 'opus');
  assert.equal(
    after.hooks.PreToolUse[0].hooks[0].command,
    'echo unrelated-pre-hook'
  );
  const cmds = stopCommands(after);
  assert.ok(cmds.includes('echo unrelated-stop-hook'));
  // ours added
  assert.ok(cmds.includes(hookCommand()));
});

test('addHook is idempotent and does not rewrite the file on the no-op path', () => {
  const settingsPath = tmpSettings(existingSettings());
  addHook(settingsPath);
  const before = fs.readFileSync(settingsPath, 'utf8');
  const second = addHook(settingsPath);
  assert.equal(second.added, false);
  const afterText = fs.readFileSync(settingsPath, 'utf8');
  // "left as-is" must hold at the byte level: the already-present branch
  // must not call writeSettings at all.
  assert.equal(afterText, before);
  const after = JSON.parse(afterText);
  const ours = stopCommands(after).filter((c) => c === hookCommand());
  assert.equal(ours.length, 1);
});

test('addHook creates settings file from {} when missing', () => {
  const settingsPath = tmpSettings(undefined);
  const result = addHook(settingsPath);
  assert.equal(result.added, true);
  assert.equal(result.backedUp, false); // nothing existed to back up
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(stopCommands(after), [hookCommand()]);
});

test('removeHook removes only our entry, preserves everything else', () => {
  const settingsPath = tmpSettings(existingSettings());
  addHook(settingsPath);
  const result = removeHook(settingsPath);
  assert.equal(result.removed, true);
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const cmds = stopCommands(after);
  assert.ok(cmds.includes('echo unrelated-stop-hook'));
  assert.ok(!cmds.includes(hookCommand()));
  assert.equal(after.model, 'opus');
  assert.equal(
    after.hooks.PreToolUse[0].hooks[0].command,
    'echo unrelated-pre-hook'
  );
});

test('removeHook on missing file is a safe no-op', () => {
  const settingsPath = tmpSettings(undefined);
  const result = removeHook(settingsPath);
  assert.equal(result.removed, false);
  assert.ok(!fs.existsSync(settingsPath));
});

test('removeHook writes .bak before removing, matching pre-removal content', () => {
  const settingsPath = tmpSettings(existingSettings());
  addHook(settingsPath);
  const preRemoval = fs.readFileSync(settingsPath, 'utf8');

  const result = removeHook(settingsPath);
  assert.equal(result.removed, true);
  assert.equal(result.backedUp, true);
  assert.ok(fs.existsSync(settingsPath + '.bak'));
  const bak = fs.readFileSync(settingsPath + '.bak', 'utf8');
  assert.equal(bak, preRemoval);
});

test('addHook throws an actionable error on corrupt JSON, file untouched, no .bak written', () => {
  const settingsPath = tmpSettings(undefined);
  const corrupt = '{ this is not valid JSON';
  fs.writeFileSync(settingsPath, corrupt);

  assert.throws(
    () => addHook(settingsPath),
    (err) =>
      err instanceof Error &&
      err.message.includes('not valid JSON') &&
      err.message.includes(settingsPath)
  );

  assert.equal(fs.readFileSync(settingsPath, 'utf8'), corrupt);
  assert.ok(!fs.existsSync(settingsPath + '.bak'));
});

test('setup.mjs self-runs when invoked via a symlinked path (macOS /tmp, npm .bin)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-symlink-'));
  const realSetup = path.join(process.cwd(), 'plugin', 'scripts', 'setup.mjs');
  // /tmp on macOS is itself a symlink to /private/tmp, so tmp is already a
  // symlinked view of the real dir on darwin; add an explicit symlink too so
  // the test also exercises the shim case on platforms with a real /tmp.
  const linkDir = path.join(tmp, 'bin');
  fs.mkdirSync(linkDir);
  const link = path.join(linkDir, 'setup-shim.mjs');
  fs.symlinkSync(realSetup, link);
  const res = spawnSync(process.execPath, [link], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
    input: '', // stdin closes immediately -> clean exit-1 path, but main MUST run
  });
  // Before the realpath fix this printed nothing and exited 0 (main never ran).
  // After: main runs, probes codex, and the closed stdin produces the guarded
  // exit-1 message — proof the guard matched through the symlink.
  const out = res.stdout + res.stderr;
  assert.match(out, /Found Codex CLI|codex CLI not found|stdin closed/i);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('setup.mjs accepts piped answers delivered in one chunk (agent/Bash-tool flow)', () => {
  const tmp = fs.mkdtempSync(fs.realpathSync(os.tmpdir()) + path.sep + 'cv-piped-');
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(proj);
  const setup = path.join(process.cwd(), 'plugin', 'scripts', 'setup.mjs');
  const res = spawnSync(process.execPath, [setup], {
    encoding: 'utf8',
    cwd: proj,
    env: { ...process.env, HOME: tmp, USERPROFILE: tmp, CLAUDE_PLUGIN_ROOT: path.dirname(path.dirname(setup)) },
    input: 'project\nproject\n', // both answers in ONE chunk — readline would drop the second
  });
  const out = res.stdout + res.stderr;
  assert.equal(res.status, 0, out);
  assert.match(out, /Setup complete/);
  assert.match(out, /Plugin install detected/); // env var set -> no settings.json merge
  const conf = fs.readFileSync(path.join(proj, '.claude', 'crossverify.conf'), 'utf8');
  assert.match(conf, /enabled=1/);
  assert.match(conf, /output=project/);
  assert.ok(!fs.existsSync(path.join(tmp, '.claude', 'settings.json')), 'settings.json must not be created in plugin context');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// M2: install.mjs (the clone-path entry point, `git clone <repo> && node
// install.mjs`) does `import { main } from './plugin/scripts/setup.mjs'` with
// a relative specifier. Spawn it from the repo root exactly the way a real
// user would, with stdin closed immediately, and assert it reaches the same
// guarded "stdin closed" exit as setup.mjs itself — proof the relative
// import actually resolves end to end, not just that setup.mjs works when
// invoked directly.
test('node install.mjs (repo root) resolves the relative import and reaches the setup dialog', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-install-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-install-bin-'));
  installFakeCodex(bin);
  const repoRoot = process.cwd();
  const installPath = path.join(repoRoot, 'install.mjs');
  const env = { HOME: home, USERPROFILE: home, PATH: fakePathEntries(bin).join(path.delimiter) };
  for (const k of ['SystemRoot', 'PATHEXT', 'ComSpec']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  const res = spawnSync(process.execPath, [installPath], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    input: '', // stdin closes immediately -> guarded exit-1 dialog path
    timeout: 30_000,
  });
  const out = res.stdout + res.stderr;
  assert.match(out, /Found Codex CLI/, `expected detectCodex to succeed first; got: ${out}`);
  assert.match(out, /stdin closed/);
  assert.equal(res.status, 1);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(bin, { recursive: true, force: true });
});
