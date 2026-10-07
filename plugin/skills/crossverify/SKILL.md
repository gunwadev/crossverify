---
name: crossverify
description: Use when the user says any of — turn on the verifier, turn off verification here, disable crossverify, verify status, show the last verifier report, what did the verifier say, why can't the agent stop, verifier blocked my agent — or asks in similar words to enable, disable, inspect, or explain the crossverify Stop-hook verifier. Also use for "verify this project", "check verifier status", "enable crossverify globally", "lock the verifier config", "add a second reviewer", "run the second reviewer", "second opinion on that turn", "firerouter check", "turn on firerouter review", "what gaps did the verifier find", "turn off gap analysis", "verify with fireworks", "codex is down, use fireworks", "the verifier hit its usage limit", "why did the verifier not run". Wraps the crossverify CLI so an agent can toggle and read the cross-vendor (Codex) read-only verifier without hand-editing config files.
---

## What crossverify is

crossverify is a Claude Code Stop hook that runs Codex — a different AI vendor, in a read-only sandbox — against the transcript of your last turn, and reports whether the claims you made about your own work actually hold up. Every report also carries a **gap analysis** (things the turn left missing or fragile, each with cited evidence; advisory, never blocking). A **second independent reviewer** (the same read-only run, same prompt, same atomic claims and gaps, but through FireRouter on Fireworks AI, a third vendor) is available on demand; see "Two reviewers" below. It ships as a plugin with its own CLI (`crossverify`) and this skill, so an agent can check status, read reports, or toggle it on the user's behalf instead of hand-editing config files.

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
- Run the second reviewer (Fireworks) on the last turn right now: `crossverify second now` (see "Two reviewers" for when and how)
- Is Fireworks usable right now? `crossverify second check` (one 1-token request; prints OK / SUSPENDED / RATE LIMITED / KEY REJECTED; exit 0 only on OK). Run it when the user asks "is fireworks working", before `second now`, and whenever a report shows `second.status: "error"`
- One-time setup of the second reviewer: `crossverify second setup`; every-turn mode (not recommended): `crossverify second on` / `crossverify second off`
- Gap analysis is on by default: `crossverify gaps off` / `crossverify gaps on`
- Lock the global config so a project can only enable, never disable, verification (user-initiated only — see Lock below): `crossverify lock on`
- Remove that lock: `crossverify lock off`
- See the resolved config and which layer (env/project/global/default) decided each key: `crossverify status` or `crossverify status --json`
- Read the latest report for this project: `crossverify report` or `crossverify report --json`
- Remove the hook, global config, and global state, printing every path removed: `crossverify uninstall` (prompts for y/N confirmation; use `crossverify uninstall --yes` in non-interactive shells). Project-level files (`.claude/crossverify.conf`, `<project>/.crossverify/`) are not touched — delete per project.
- Full usage and examples: `crossverify help`

## Two reviewers: Codex (always on) and Fireworks (on demand)

There are two independent verifiers. Both run the identical read-only job (same system prompt, same rule pack, same schema, atomic claims plus gap analysis). What differs is the vendor:

| | Primary | Second |
|---|---|---|
| Runs through | OpenAI Codex CLI, your own `~/.codex` login | Codex CLI pointed at Fireworks AI (model `firerouter`, a router across Claude and open models) via a separate home `~/.claude/crossverify/codex-home-second/` |
| When | Every Stop with file changes, automatically | Only when invoked (see below). It is `second=off` by default and should stay that way: the Fireworks key is shared with Claude Code itself and gets rate-limited (HTTP 429) when the reviewer runs on every Stop |
| Setup | `codex login` | `fireconnect login` once, then `crossverify second setup` once (needs the `fireconnect` CLI; it writes only the separate home, never the user's real `~/.codex/config.toml`) |
| Model override | `CROSSVERIFY_MODEL` | `CROSSVERIFY_SECOND_MODEL` (any Fireworks serverless id, e.g. `glm-latest`, `kimi-latest`) |

### How to invoke the second reviewer

1. **The user asks for it** ("run the second reviewer", "second opinion on that turn", "firerouter check", "verify with fireworks", "get fireworks to check this"): run `crossverify second now` in the project directory. It re-verifies the newest transcript of this project with BOTH reviewers, waits (a few minutes), prints the report, never blocks, never touches the attempt counter. Use `--transcript <path>` for a specific session file or `--session <id>` to pick one under `~/.claude/projects/`.
2. **The user wants the next Stop checked by both** (for example before finishing a large change): set `CROSSVERIFY_SECOND=1` in the environment for that run. Per-run, no config change. `CROSSVERIFY_SECOND=0` disables for one run and is gated by the lock.
3. **Every turn**: only if the user explicitly asks for it: `crossverify second on`. Expect 429s during busy sessions.

Before a `second now`, or when the user asks whether Fireworks works, run `crossverify second check` first: it costs one token and tells you in seconds what a verify run would take minutes to discover. If `crossverify second now` says there is no second reviewer configured, run `crossverify second setup` (it fails fast with an install pointer if `fireconnect` is missing). Do not run `fireconnect codex on` yourself against the user's real Codex config.

### Which vendor decides (availability playbook)

| Situation | What the report shows | What you do |
|---|---|---|
| Both up | `second.agreed: true/false`; primary decides. Second with concrete failures escalates `unsure` to `failed`; second failing a `verified` primary makes it `unsure` with the disagreement in `needs_from_user` | Act on `failed` as usual. On a disagreement, read both sides and tell the user; the hook never blocks on one dissenting vote |
| Codex down (usage limit, auth, timeout, garbage output) | `second.promoted: true`, top-level `primary_error` one-liner, the verdict and claims are the Fireworks reviewer's | Treat it as the verdict. Tell the user Codex is out and why (`primary_error`, e.g. "usage limit, try again Oct 9") |
| Fireworks down (412 suspended, 429 rate limit, timeout) | `second.status: "error"` with a one-line `second.error`; the Codex verdict stands | Treat it as the verdict. Run `crossverify second check` to name the cause, tell the user (billing page for 412, wait for 429), offer to retry later or with `CROSSVERIFY_SECOND_MODEL` set to a specific model |
| Both down | No report written; `hook.log` has one line `both reviewers failed: primary (...) second <model> (...)` | Tell the user neither vendor could verify, quote both causes, and do your own evidence-based self-check before finishing |
| Second reviewer `hollow: true` (also `hollow_hint`) | The Fireworks run returned `unsure` with zero claims on a turn that changed files: it inspected nothing | Treat as no verdict. Re-run with `CROSSVERIFY_SECOND_MODEL` set to a specific model (the router picked a lazy one) |

"Why did the verifier not run?" is answered by `~/.claude/crossverify/hook.log`: look for `skip:` lines (disabled, no mutations, attempt cap, codex missing), `failed open`, `promoted`, or `both reviewers failed`.

## Gap analysis

Every verdict (both reviewers) carries `gaps`: what the turn left missing or fragile that the builder never claimed, in the turn's blast radius (missing error handling, no test for new behavior, unbounded loops or logs, stale docs or config, callers not updated, unvalidated input). It is on by default (`gaps=on`), advisory, and never blocks or counts as a failed claim. The contract: each gap is `CONFIRMED` (the verifier read the source and cites `file:line`, or names the file and the absent section) or `OPEN_QUESTION` (could not be checked read-only; the evidence names the check that would settle it). Unverified plausibilities are dropped before they reach you.

How to use them: when a block message or report lists gaps, treat them as a review checklist. Fix the CONFIRMED ones that matter to the user's request, answer or verify the OPEN_QUESTIONs, and mention the rest to the user in one line each. Never silently ignore a CONFIRMED gap. `crossverify gaps off` only when the user asks.

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
- `needs_from_user` — a string describing suggestions for how to improve the verifier itself for the next run (missing rule, missing tool, missing fixture, or external oracle). Empty when nothing's needed. This is feedback for improving verification coverage, not a mid-task blocker — surface it to the user as a suggestion for enhancing the verifier's completeness. When the two reviewers disagree, the disagreement is recorded here.
- `gaps` — the gap analysis: an array of `{gap, classification, evidence, fix}`. `classification` is `CONFIRMED` (the verifier read the source and cites it) or `OPEN_QUESTION` (could not be checked read-only; `evidence` names the check that would settle it). Gaps never block and never count as failed claims. Treat them as a review checklist: fix the CONFIRMED ones that matter, answer the OPEN_QUESTIONs, tell the user about the rest.
- `second` — present when the second reviewer ran: `{model, status, confidence, claims_failed, failed, feedback, agreed}` (or `{model, status: "error", error}` when it failed open; or `{..., promoted: true}` plus a top-level `primary_error` when the primary had no verdict and the second reviewer's verdict stands alone; `hollow: true` plus a top-level `hollow_hint` when that standalone verdict inspected nothing). Full playbook in "Two reviewers". Merge rule: the primary decides; a second reviewer with concrete failures escalates an `unsure` primary to `failed`, and turns a `verified` primary into `unsure` with the disagreement in `needs_from_user` (never a block on its own).

## File locations

- Project config: `.claude/crossverify.conf` (relative to the project root)
- Global config: `~/.claude/crossverify/config`
- Reports, when `output=project` (default): `<project>/.crossverify/`
- Reports, when `output=global`: `~/.claude/crossverify/reports/`
- Hook log (always in the state directory, regardless of `output`): `~/.claude/crossverify/hook.log`
- Second reviewer Codex home (written by `crossverify second setup`): `~/.claude/crossverify/codex-home-second/` (its `config.toml` holds the Fireworks provider block; the user's real `~/.codex` is never touched)
- Transcripts the on-demand run reads: `~/.claude/projects/<cwd with non-alphanumerics replaced by '-'>/<session>.jsonl`

## Anti-instructions

- Never hand-edit `.claude/crossverify.conf` or `~/.claude/crossverify/config` directly. Always go through the `crossverify` CLI — it keeps the two config layers consistent and logs every disable, which a raw file edit would silently skip.
- NEVER disable verification (`crossverify off`, `crossverify global off`, or editing `enabled=0` some other way) and NEVER downgrade enforcement (`mode` from `foreground` to `background`, `failmode` from `closed` to `open`, `second` or `gaps` from `on` to `off`, in any config file) just to make a block go away. A downgrade defangs blocking while status still shows enabled — the lock gates these downgrades too, and the hook logs them. A block means the verifier found failed claims, not that the verifier is malfunctioning. Instead: run `crossverify report --json`, read the failed claims, fix the actual work, and let the hook re-check on your next Stop. Disabling verification to escape a block hides a real problem from the user — surface the failed claims instead.
- If disabling fails with an error like `enabled=0 ignored: locked by global config (lock=1)`, do not look for a workaround and do not run `crossverify lock off` yourself. Tell the user the project is locked and that only they can run `crossverify lock off` to unlock it, then wait for them to do so.

## Lock

`lock=1` is a global-only setting: once set, a project's `enabled=0` is ignored, and so are project-level enforcement downgrades (`mode` foreground→background, `failmode` closed→open, `second`/`gaps` on→off) — a project cannot silently turn its own verifier off or defang it (this closes the "builder agent disables the thing checking it" hole). If a user asks why `crossverify off` isn't taking effect, run `crossverify status --json` to confirm `lock` is on and check `decidedBy` for the `enabled` key — then tell the user only they can lift it with `crossverify lock off`; an agent should never run that command speculatively on their behalf.

When reading `crossverify status --json`, the `decidedBy` field explains which layer (env, project, global, or default) set each config key.
