---
name: crossverify
description: Use when the user says any of — turn on the verifier, turn off verification here, disable crossverify, verify status, show the last verifier report, what did the verifier say, why can't the agent stop, verifier blocked my agent — or asks in similar words to enable, disable, inspect, or explain the crossverify Stop-hook verifier. Also use for "verify this project", "check verifier status", "enable crossverify globally", "lock the verifier config". Wraps the crossverify CLI so an agent can toggle and read the cross-vendor (Codex) read-only verifier without hand-editing config files.
---

## What crossverify is

crossverify is a Claude Code Stop hook that runs Codex — a different AI vendor, in a read-only sandbox — against the transcript of your last turn, and reports whether the claims you made about your own work actually hold up. It ships as a plugin with its own CLI (`crossverify`) and this skill, so an agent can check status, read reports, or toggle it on the user's behalf instead of hand-editing config files.

## CLI invocations for each intent

Run these with the `crossverify` CLI (Bash tool). Every subcommand also has `crossverify help` for full usage. If `crossverify` is not found on PATH (plugin and clone installs don't add it), use `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" <args>` (plugin) or `node <clone>/plugin/scripts/cli.mjs <args>` (clone) instead — same subcommands, same output.

- Turn the verifier on for this project: `crossverify on`
- Turn the verifier off for this project: `crossverify off`
- Turn the verifier on for every project (global default): `crossverify global on`
- Turn the verifier off globally: `crossverify global off`
- Move report output to the project directory: `crossverify output project`
- Move report output to the global state directory: `crossverify output global`
- Switch the active rule pack: `crossverify pack <name>`
- Let external-world claims be fact-checked by a separate search-isolated pass (off by default): `crossverify research on` / `crossverify research off`
- Lock the global config so a project can only enable, never disable, verification (user-initiated only — see Lock below): `crossverify lock on`
- Remove that lock: `crossverify lock off`
- See the resolved config and which layer (env/project/global/default) decided each key: `crossverify status` or `crossverify status --json`
- Read the latest report for this project: `crossverify report` or `crossverify report --json`
- Remove the hook, global config, and global state, printing every path removed: `crossverify uninstall` (prompts for y/N confirmation; use `crossverify uninstall --yes` in non-interactive shells). Project-level files (`.claude/crossverify.conf`, `<project>/.crossverify/`) are not touched — delete per project.
- Full usage and examples: `crossverify help`

## How to read a report

`crossverify report --json` returns one JSON object with these fields:

- `status` — `"verified"`, `"failed"`, or `"unsure"`. The overall verdict for the last checked turn.
- `confidence` — one of `"PERFECT"`, `"VERIFIED"`, `"PARTIAL"`, `"FEEDBACK"`, or `"FAILED"`. How confident the verifier is in the status.
- `claims_total` — how many atomic claims the verifier extracted from the turn.
- `claims_verified` — how many of those claims it confirmed true.
- `claims_failed` — how many it confirmed false. This is the actionable count.
- `claims_unverified` — how many it could neither confirm nor deny (read-only access wasn't enough to tell).
- `verified` — an array of `{claim, evidence}` objects for claims proven true.
- `failed` — an array of `{claim, evidence}` objects for claims proven false. This is what to act on: understand each claim, read the evidence, and fix the actual work.
- `could_not_verify` — an array of `{claim, reason}` objects for claims that could not be proven or disproven.
- `external_claims` — short keyword topics for external-world claims the verify pass could not settle locally (emitted when research is on; they are checked by a separate search-only pass).
- `research` — present when research ran: an array of `{topic, verdict, evidence}` fact-check results with cited sources.
- `feedback` — a concrete corrective message for the builder when status=`failed`. Empty otherwise.
- `needs_from_user` — a string describing suggestions for how to improve the verifier itself for the next run (missing rule, missing tool, missing fixture, or external oracle). Empty when nothing's needed. This is feedback for improving verification coverage, not a mid-task blocker — surface it to the user as a suggestion for enhancing the verifier's completeness.

## File locations

- Project config: `.claude/crossverify.conf` (relative to the project root)
- Global config: `~/.claude/crossverify/config`
- Reports, when `output=project` (default): `<project>/.crossverify/`
- Reports, when `output=global`: `~/.claude/crossverify/reports/`
- Hook log (always in the state directory, regardless of `output`): `~/.claude/crossverify/hook.log`

## Anti-instructions

- Never hand-edit `.claude/crossverify.conf` or `~/.claude/crossverify/config` directly. Always go through the `crossverify` CLI — it keeps the two config layers consistent and logs every disable, which a raw file edit would silently skip.
- NEVER disable verification (`crossverify off`, `crossverify global off`, or editing `enabled=0` some other way) and NEVER downgrade enforcement (`mode` from `foreground` to `background`, or `failmode` from `closed` to `open`, in any config file) just to make a block go away. A downgrade defangs blocking while status still shows enabled — the lock gates these downgrades too, and the hook logs them. A block means the verifier found failed claims, not that the verifier is malfunctioning. Instead: run `crossverify report --json`, read the failed claims, fix the actual work, and let the hook re-check on your next Stop. Disabling verification to escape a block hides a real problem from the user — surface the failed claims instead.
- If disabling fails with an error like `enabled=0 ignored: locked by global config (lock=1)`, do not look for a workaround and do not run `crossverify lock off` yourself. Tell the user the project is locked and that only they can run `crossverify lock off` to unlock it, then wait for them to do so.

## Lock

`lock=1` is a global-only setting: once set, a project's `enabled=0` is ignored, and so are project-level enforcement downgrades (`mode` foreground→background, `failmode` closed→open) — a project cannot silently turn its own verifier off or defang it (this closes the "builder agent disables the thing checking it" hole). If a user asks why `crossverify off` isn't taking effect, run `crossverify status --json` to confirm `lock` is on and check `decidedBy` for the `enabled` key — then tell the user only they can lift it with `crossverify lock off`; an agent should never run that command speculatively on their behalf.

When reading `crossverify status --json`, the `decidedBy` field explains which layer (env, project, global, or default) set each config key.
