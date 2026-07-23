// codex.mjs — builds the verifier prompt and runs the Codex CLI headless.
// Behavioral reference: the local bash hook's prompt heredoc + run_codex_and_report.
// Node stdlib only. runCodex never rejects: every failure resolves {ok:false, error}
// so the caller can apply its failmode (fail-open by default).
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VALID_STATUSES = new Set(['verified', 'failed', 'unsure']);

// Windows: `codex` on PATH is usually a .cmd shim. Node's spawn() with
// shell:false cannot execute .cmd files directly (it hard-errors with
// EINVAL/ENOENT depending on version) even though the same lookup with
// shell:true (as the old gate probe used) works fine — that mismatch is
// exactly why setup could pass while every real run failed. Resolve to a
// concrete command once, share it between the gate probe (probeCodex) and
// the real run (runCodex), so both agree about how codex actually launches.
// Non-win32 is untouched: spawn('codex', ...) already works there.
export function resolveCodexCommand() {
  if (process.platform !== 'win32') {
    return { command: 'codex', wrap: (args) => args };
  }
  // PATHEXT-defaulted env: hook processes can run with a stripped environment;
  // without PATHEXT, where.exe never matches codex.cmd/codex.exe.
  const where = spawnSync('where.exe', ['codex'], {
    encoding: 'utf8',
    env: { ...process.env, PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD' },
  });
  const candidates = (where.status === 0 ? where.stdout : '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const exe = candidates.find((c) => c.toLowerCase().endsWith('.exe'));
  if (exe) return { command: exe, wrap: (args) => args };
  const cmd = candidates.find((c) => c.toLowerCase().endsWith('.cmd')) || candidates[0];
  if (cmd) {
    // .cmd shims can't be spawned directly with shell:false on Windows —
    // invoke them through cmd.exe instead. The argv passed through here is
    // only our static prompt asset + local paths (no untrusted repo content
    // flows through the shell), so this is not a command-injection surface.
    return { command: 'cmd.exe', wrap: (args) => ['/d', '/s', '/c', cmd, ...args] };
  }
  // Not found: fall through to a plain 'codex' spawn so the ENOENT surfaces
  // through the normal error path (caller decides fail-open behavior).
  return { command: 'codex', wrap: (args) => args };
}

// Shared PATH probe used by both the Stop-hook Gate 6 check (verifier.mjs)
// and setup's Codex-present check — same resolution logic as runCodex.
export function probeCodex() {
  const resolved = resolveCodexCommand();
  const probe = spawnSync(resolved.command, resolved.wrap(['--version']), { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

export function buildPrompt({ systemPromptText, cwd, transcriptPath, rulesPath, attempt, maxAttempts, research }) {
  return [
    systemPromptText,
    '',
    '---',
    '',
    `WORKING_DIR: ${cwd}`,
    `TRANSCRIPT_PATH: ${transcriptPath}`,
    `RULES: ${rulesPath}`,
    `ATTEMPT: ${attempt} of ${maxAttempts}`,
    `RESEARCH: ${research}`,
    '',
    "Read the rules file. Read the transcript. Verify the builder's work. Output JSON only, matching the schema.",
  ].join('\n');
}

export function validateVerdict(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return typeof obj.status === 'string' && VALID_STATUSES.has(obj.status);
}

// Codex sometimes wraps its JSON in a markdown code fence; unwrap it if so.
function stripFences(text) {
  const trimmed = text.trim();
  const m = trimmed.match(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/);
  return m ? m[1].trim() : trimmed;
}

export function runCodex({ prompt, cwd, model, schemaPath, timeoutMs, codexHome, search = false, validate = validateVerdict }) {
  const lastMsgFile = path.join(os.tmpdir(), `crossverify-last-msg-${randomUUID()}.txt`);
  // Prompt travels via STDIN (`codex exec -`), never argv: on Windows the
  // .cmd-shim lane re-parses the command line through cmd.exe, where embedded
  // quotes/newlines/&/> in the prompt are live metacharacters, and argv also
  // caps at 32K there. Stdin has neither problem, on any platform.
  const args = [
    // research=on: codex's NATIVE web_search tool (server-side at OpenAI) —
    // the local sandbox stays read-only; no raw network egress is granted.
    // Root-level flag: must precede the `exec` subcommand.
    ...(search ? ['--search'] : []),
    'exec',
    '--model', model,
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--cd', cwd,
    '--output-schema', schemaPath,
    '--output-last-message', lastMsgFile,
    '--color', 'never',
    '-',
  ];
  const env = { ...process.env };
  if (codexHome) env.CODEX_HOME = codexHome;
  const signal = AbortSignal.timeout(timeoutMs);
  const resolved = resolveCodexCommand();

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      // Keep lastMsgFile only when the caller gets its path back for raw
      // archival; every other outcome unlinks it (best effort) so failed and
      // timed-out runs don't litter the tmpdir.
      if (!result.rawPath) {
        try { fs.unlinkSync(lastMsgFile); } catch { /* best effort */ }
      }
      resolve(result);
    };

    let child;
    const stderrChunks = [];
    const stderrTail = () => {
      const text = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (text === '') return '';
      return ` | stderr: ${text.length > 500 ? text.slice(-500) : text}`;
    };

    // On win32 the signal kill only reaches the cmd.exe wrapper — the real
    // codex process underneath survives as an orphan (still holding files and,
    // with a real codex, still consuming API after "timeout"). Kill the whole
    // tree explicitly on abort. MUST be registered BEFORE spawn(): listeners
    // fire in registration order, and spawn()'s internal handler kills the
    // wrapper first — after which taskkill /t cannot walk the dead parent's
    // tree and the orphan survives (observed live on Windows).
    if (process.platform === 'win32') {
      signal.addEventListener(
        'abort',
        () => {
          if (child && child.pid) {
            try {
              spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
            } catch {
              // best effort — the wrapper kill still happens via `signal`
            }
          }
        },
        { once: true }
      );
    }

    try {
      child = spawn(resolved.command, resolved.wrap(args), {
        cwd,
        env,
        signal,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    } catch (err) {
      done({ ok: false, error: `codex spawn failed: ${err.message}` });
      return;
    }

    child.stdin.on('error', () => { /* EPIPE if codex dies early — close handles it */ });
    child.stdin.end(prompt);
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    // Fires for ENOENT (codex not installed) and for the abort/timeout kill.
    child.on('error', (err) => {
      if (signal.aborted) {
        done({ ok: false, error: `codex timed out after ${timeoutMs}ms${stderrTail()}` });
      } else {
        done({ ok: false, error: `codex spawn error: ${err.message}${stderrTail()}` });
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        done({
          ok: false,
          error: (signal.aborted
            ? `codex timed out after ${timeoutMs}ms`
            : `codex exited with code ${code}`) + stderrTail(),
        });
        return;
      }
      let raw;
      try {
        raw = fs.readFileSync(lastMsgFile, 'utf8');
      } catch {
        done({ ok: false, error: 'no output from codex (last-message file missing)' });
        return;
      }
      if (raw.trim() === '') {
        done({ ok: false, error: 'no output from codex (last-message file empty)' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stripFences(raw));
      } catch (err) {
        // Keep the raw file for post-mortem; caller decides where to archive it.
        done({ ok: false, error: `verifier output not valid JSON: ${err.message}`, rawPath: lastMsgFile });
        return;
      }
      if (!validate(parsed)) {
        done({ ok: false, error: 'codex output failed the shape check for this run', rawPath: lastMsgFile });
        return;
      }
      done({ ok: true, verdict: parsed });
    });
  });
}
