---
description: Interactive setup for crossverify — enable the Stop-hook verifier, choose global or per-project scope, and pick where reports are written.
---

Run the crossverify setup engine and act as the interactive bridge between it and the user:

1. Run `CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"` in the current working directory. (The explicit `CLAUDE_PLUGIN_ROOT=` prefix matters: this command is prompt-substituted, not exported into the child process's environment, so without it setup.mjs cannot tell it's running as a plugin and would wrongly merge a Stop hook into settings.json alongside the one hooks.json already provides.)
2. The script asks a short sequence of questions on stdout (Codex CLI presence, global vs. project enable, output location, optional statusline segment) and reads one answer per line from stdin.
3. For each question the script prints, stop and ask the user that same question verbatim in the chat, wait for their reply, then send exactly their reply as the next line of input to the running process.
4. Continue relaying questions and answers in order, one at a time, until the script exits.
5. When the script finishes, print its final summary — every file it wrote or changed — to the user unedited. Do not paraphrase or omit any path it reports.
6. If the script exits non-zero or prints an error (for example: Codex CLI not found), show the exact error text and stop. Do not attempt setup steps the script itself did not perform.
