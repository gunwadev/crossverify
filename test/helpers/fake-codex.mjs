// test/helpers/fake-codex.mjs — cross-platform fake `codex` for tests.
//
// POSIX: an extensionless executable Node script on PATH (shebang).
// Windows: a codex.cmd shim + codex-impl.cjs pair — shebangs don't execute
// on win32, and this shape doubles as a live test of resolveCodexCommand's
// where.exe -> cmd.exe /d /s /c wrapping of npm-style .cmd shims.
//
// Behavior (same on both platforms):
//   codex --version                 -> prints "codex-fake 0.0.0", exit 0
//   codex exec ... --output-last-message <out> ...
//     -> waits FAKE_DELAY_MS (default 0), then writes either
//        (a) the literal PAYLOAD baked in at install time (payload mode), or
//        (b) the contents of $FAKE_VERDICT_FILE (env mode),
//        with "__CODEX_HOME__" replaced by $CODEX_HOME, then exits
//        $FAKE_CODEX_EXIT (default 0).

import fs from 'node:fs';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

function implSource({ payload, delayMs, echoStdin, routeByHome }) {
  return [
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "if (args[0] === '--version') { console.log('codex-fake 0.0.0'); process.exit(0); }",
    "const i = args.indexOf('--output-last-message');",
    'const out = i >= 0 ? args[i + 1] : null;',
    echoStdin
      ? "let body = fs.readFileSync(0, 'utf8');" // echo mode: verdict = the prompt received on stdin, verbatim
      : payload !== undefined
        ? `let body = ${JSON.stringify(payload)};`
        : "let body = process.env.FAKE_VERDICT_FILE && fs.existsSync(process.env.FAKE_VERDICT_FILE) ? fs.readFileSync(process.env.FAKE_VERDICT_FILE, 'utf8') : '';",
    // JSON-escape the substitution: on Windows CODEX_HOME contains backslashes,
    // which would corrupt a JSON payload if spliced in raw.
    // routeByHome: { [codexHome]: verdictFile } — serve a different verdict
    // when CODEX_HOME matches (the second reviewer runs with its own home).
    `const routes = ${JSON.stringify(routeByHome || {})};`,
    "if (process.env.CODEX_HOME && routes[process.env.CODEX_HOME]) body = fs.readFileSync(routes[process.env.CODEX_HOME], 'utf8');",
    "body = body.replace('__CODEX_HOME__', JSON.stringify(process.env.CODEX_HOME || 'unset').slice(1, -1));",
    // FAKE_CODEX_EXIT_FOR_HOME: fail only the run whose CODEX_HOME matches.
    "const code = (process.env.FAKE_CODEX_EXIT_FOR_HOME && process.env.FAKE_CODEX_EXIT_FOR_HOME === (process.env.CODEX_HOME || '__unset__')) ? 1 : Number(process.env.FAKE_CODEX_EXIT || 0);",
    `setTimeout(() => { if (out && body !== '') fs.writeFileSync(out, body); process.exit(code); }, ${delayMs});`,
    '',
  ].join('\n');
}

// Writes the fake into dir. payload === undefined -> env mode.
// echoStdin: true -> the fake writes its stdin (the prompt) as the verdict.
export function installFakeCodex(dir, { payload, delayMs = 0, echoStdin = false, routeByHome } = {}) {
  if (IS_WIN) {
    const impl = path.join(dir, 'codex-impl.cjs');
    fs.writeFileSync(impl, implSource({ payload, delayMs, echoStdin, routeByHome }));
    // %errorlevel% propagation: node is the last command; exit /b forwards it.
    const shim = ['@echo off', `"${process.execPath}" "%~dp0codex-impl.cjs" %*`, 'exit /b %errorlevel%', ''].join('\r\n');
    fs.writeFileSync(path.join(dir, 'codex.cmd'), shim);
  } else {
    const script = '#!/usr/bin/env node\n' + implSource({ payload, delayMs, echoStdin, routeByHome });
    fs.writeFileSync(path.join(dir, 'codex'), script, { mode: 0o755 });
  }
}

// Minimal PATH for spawning the fake: its dir, the node dir (POSIX shebang
// resolution), and enough system dirs for cmd.exe/where.exe (win) or sh (POSIX).
export function fakePathEntries(binDir, { withCodex = true } = {}) {
  const entries = withCodex ? [binDir] : [];
  if (IS_WIN) {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    entries.push(path.dirname(process.execPath), path.join(sysRoot, 'System32'), sysRoot);
  } else {
    entries.push(path.dirname(process.execPath), '/usr/bin', '/bin');
  }
  return entries;
}
