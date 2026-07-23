// lib/prompt.mjs — shared EOF-safe, pipe-safe stdin question helpers.
//
// Why not readline.question() directly: readline discards any line that
// arrives while no question is pending. A piped stdin ("project\nproject\n")
// delivers every answer in one data chunk, and readline emits all lines
// synchronously — so every answer after the first lands before the next
// question() call registers and is silently lost. Observed live: the
// /crossverify:setup flow runs through a non-interactive Bash tool and hit
// exactly this. The prompter below buffers lines from the moment the
// interface is created, so early answers wait for their questions instead of
// vanishing. EOF stays a first-class outcome: asking after input has ended
// rejects with StdinClosedError instead of hanging forever (Node would
// otherwise force-exit on the unsettled top-level await).
//
// Used by setup.mjs (setup dialog) and cli.mjs (uninstall confirmation) so
// piped and interactive stdin behave identically everywhere.

import readline from 'node:readline';

export class StdinClosedError extends Error {}

export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, output });
  const lines = [];
  let closed = false;
  let waiter = null; // { resolve, reject } for at most one pending ask()

  rl.on('line', (line) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.resolve(line);
    } else {
      lines.push(line);
    }
  });

  rl.on('close', () => {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(new StdinClosedError('stdin closed before an answer was given'));
    }
  });

  return {
    // Write the prompt, then return the next line: an already-buffered one
    // (piped input) or the next to arrive (interactive input).
    ask(prompt) {
      output.write(prompt);
      if (lines.length > 0) return Promise.resolve(lines.shift());
      if (closed) {
        return Promise.reject(
          new StdinClosedError('stdin closed before an answer was given')
        );
      }
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
    },
    close() {
      rl.close();
    },
  };
}
