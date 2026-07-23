# crossverify

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![Platforms](https://img.shields.io/badge/verified%20on-macOS%20%7C%20Linux%2FWSL-blue.svg)](#windows-use-wsl-for-now)

A second, independent AI agent checks the first agent's work before you have to.

[Quick start](#quick-start) •
[What it catches](#what-it-catches) •
[How it works](#how-it-works) •
[Configuration](#configuration) •
[Security](#security)

crossverify is a Claude Code plugin. When a builder agent finishes a turn, a Stop hook launches Codex (a different agent from a different vendor, in a read-only sandbox) to check what the builder claims it just did. It ships **off by default**, runs in the **background by default**, and **fails open by default**. Node stdlib only: zero dependencies, no build step, small enough to read in one sitting.

## The problem

Coding agents narrate their own success. "I added the endpoint and it works." "Tests pass." "I didn't touch that file." These are claims, not proof. And the agent that did the work is the worst-positioned to audit it: same context, same blind spots, same incentive to report done. If you run agents unattended, or fast enough that you stop reading every diff, false "done" reports become the most expensive failure mode, because you find out later.

Cross-vendor matters here. A same-vendor verifier shares training data and blind spots with the builder, and has a financial incentive to agree with itself. A different model from a different lab, limited to read-only tools, has neither.

## Quick start

**Requires:** Node 18+ on PATH (the npm install of Claude Code guarantees it; the native-binary installer doesn't — check with `node --version`) and the [Codex CLI](https://github.com/openai/codex), installed and authenticated. Setup checks for Codex and tells you what's missing if it isn't there.

```
/plugin marketplace add gunwadev/crossverify
/plugin install crossverify@crossverify
/crossverify:setup
```

Setup is interactive: it detects Codex, asks global-vs-project enable and report location, writes the config, and prints what it changed. Installing enables nothing. The hook stays **off** until you turn it on. Neither install path puts a bare `crossverify` command on your shell PATH yet (see the note below) — setup prints the exact command for your machine; with the alias it suggests, the CLI is:

```
crossverify on          # enable for this project
crossverify global on   # enable everywhere
crossverify status      # resolved state, and which layer decided each key
```

<details>
<summary><strong>Clone and read it first</strong> (audit-first path)</summary>

```
git clone https://github.com/gunwadev/crossverify
cd crossverify
node install.mjs
```

Same setup engine underneath. The whole thing is a handful of `.mjs` files with no dependencies and no build step, so what's in the repo is exactly what runs. Read it before installing if you want. You can also pin the plugin to a tag or commit SHA when adding the marketplace.

</details>

> [!NOTE]
> **`npx crossverify init` is coming soon.** The npm package is phase 2; the `bin` entry is already wired. Until it ships, neither install path puts a bare `crossverify` command on your shell PATH. Setup prints the exact command to use instead (`node <path>/cli.mjs <args>`, or a shell alias), and every doc string that mentions `crossverify report` also mentions this fallback.

### Windows: use WSL for now

> [!WARNING]
> The hook, CLI, and tests all run natively on Windows (the full suite passes there). But the verification step itself currently needs **WSL**, because `codex exec` is currently broken on native Windows — three open upstream bugs spanning the sandbox helper, tool routing, and stdin handling: openai/codex [#31744](https://github.com/openai/codex/issues/31744), [#32655](https://github.com/openai/codex/issues/32655), [#20919](https://github.com/openai/codex/issues/20919).

Verified end-to-end through WSL on real hardware: honest work passes, a lying builder gets caught, and the sandbox uses kernel-level (Landlock) read-only enforcement. Never used WSL? It's Microsoft's supported Linux layer for Windows, one command to install: follow the [official WSL install guide](https://learn.microsoft.com/en-us/windows/wsl/install) (`wsl --install`, reboot, done). Then see [docs/windows-wsl.md](docs/windows-wsl.md) for the three crossverify-specific steps (node + Codex inside WSL, sharing your Codex login). When the upstream sandbox fix lands, native Windows should work with zero changes here. In the meantime, if verification can't observe anything on Windows, the report says exactly why (`windows_hint` field) instead of pretending.

## What it catches

This has been running as a Stop hook on real coding sessions since 2026-05-04. As of 2026-07-22:

| | |
|---|---|
| Verification runs | **817** across **114 distinct sessions** |
| Atomic claims decomposed and checked | **4,777** (avg. ~5.8 per run) |
| Runs that came back `failed` with corrective feedback | **201 (~25%)** |
| Individual claims that failed outright | **276** of 4,777 |

Roughly 1 in 4 runs, the builder's account of its own work didn't hold up under an independent read-only check. These are counts from the actual report log, not a curated sample.

The unit of work is the **claim**. The builder says: *"I added the user with auth."* That's not one claim, it's at least three:

1. The user record exists.
2. The auth record exists.
3. They're linked.

The verifier checks each one independently with `read`/`grep`/`find`/read-only `bash`, and marks a claim `verified` only when it has cited, deterministic evidence: a file's actual contents, a command's actual exit code. An unverifiable claim is never silently waved through. It gets logged as `could_not_verify` with a reason.

## How it works

After a coding-agent turn ends, a **different agent from a different vendor** reads the transcript of what the builder just did and verifies it. The verifier is Codex (default model `gpt-5.4`, overridable with `CROSSVERIFY_MODEL`), independent of whatever built the code. It's not a linter or a test runner. It reads the builder's own claims, breaks each one into atomic, checkable propositions, and proves or disproves each against the actual file system and command output. Then it either passes the work through or sends it back to the builder with specific feedback: file, line, rule, fix.

```
Builder agent finishes a turn
        │
        ▼
  Stop hook fires (Claude Code)
        │
        ▼
  Transcript sliced to the last turn only
  (per-turn gate: skips pure Q&A turns with
   no Write/Edit/mutating-Bash calls)
        │
        ▼
  Codex exec, --sandbox read-only, --skip-git-repo-check
  reads: system prompt + rule pack + transcript slice
        │
        ▼
  Emits ONE JSON object matching a fixed schema:
  status (verified/failed/unsure), confidence ladder
  (PERFECT → VERIFIED → PARTIAL → FEEDBACK → FAILED),
  claims_total/verified/failed/unverified, feedback,
  needs_from_user
        │
        ▼
  ┌─────────────┴─────────────┐
  │                            │
BACKGROUND (default)       FOREGROUND (opt-in)
verdict logged to a         waits, and on
report file + statusline;   status=failed with
builder keeps going         concrete feedback,
                             blocks the builder's
                             stop and re-prompts
                             it with that feedback
```

**Loop guards.** A `stop_hook_active` check stops the verifier's own re-prompt from re-triggering itself. A per-session counter caps retries at 2; after that, the verifier defers to `unsure` instead of looping forever on a builder that isn't getting it. The same counter bounds `failmode=closed` infrastructure blocks (see [Fail mode](#fail-mode)): a verifier that's stuck erroring also gives up after 2 attempts and lets the builder stop.

**Rule packs.** What counts as a blocking failure vs. a soft warning is defined in a separate markdown rule file, not hardcoded in the prompt. The default pack ships five critical rules (existence claims, no half-finished implementations, tests claimed passing must actually show passing output in the transcript, files claimed untouched must be untouched, no fabricated imports/dependencies) and treats style, naming, and architecture opinions as non-blocking. Switch packs with `crossverify pack <name>`.

## Configuration

Working with a coding agent in a verified project? Paste [docs/claude-md-snippet.md](docs/claude-md-snippet.md) into that project's `CLAUDE.md` — five lines that tell the agent the verifier exists, how to read a block, and never to disable it.

Two plain `key=value` files, no JSON, so a stray comma can't kill the verifier: global `~/.claude/crossverify/config` and per-project `.claude/crossverify.conf`. The CLI edits them for you; hand-editing works too.

| key | values | default | what it does |
|---|---|---|---|
| `enabled` | `0` / `1` | `0` | master switch; ships off |
| `mode` | `background` / `foreground` | `background` | background writes a report and lets the builder continue; foreground waits for the verdict and blocks the builder on a failed one, re-prompting it with the feedback |
| `output` | `project` / `global` | `project` | reports in `<project>/.crossverify/` (auto-gitignored) or in the global state dir |
| `pack` | rule pack name | `default` | which rules file the verifier loads |
| `research` | `off` / `on` | `off` | adds a second, **search-isolated** verification pass for external-world claims (current versions, current events) — see below |
| `lock` | `0` / `1` | `0` | **global-only.** When `1`, a project conf may enable but never disable. See [Tamper lock](#tamper-lock) |
| `failmode` | `open` / `closed` | `open` | what happens when the verifier itself fails. See [Fail mode](#fail-mode) |

**Precedence, per key: env > project conf > global conf > default.** A project's `enabled=0` overrides a global `enabled=1`, so any project can opt out of global-on, unless the global config sets `lock=1`.

**How `research` stays leak-proof (dual-LLM pattern).** The verify pass reads your repo and transcript but can NEVER search. With `research=on`, claims only the internet can settle come out of it as short keyword topics, which pass a hard programmatic gate (max 3, length-capped, any secret-shaped token ≥20 chars dropped) before a **separate** Codex run — pointed at an empty directory, holding no repo, no transcript, no secrets — fact-checks them with Codex's native server-side `web_search` and cites sources. A disproven topic escalates an `unsure` verdict to `failed`, so foreground mode still blocks. The process that can search never saw anything worth leaking; worst-case injection shrinks from exfiltration to one bounded spurious block. Off by default; with it off, the report names each internet-only claim in `needs_from_user` so you know exactly when turning it on would help. `crossverify research on|off` per project.

**Environment variables.** `CROSSVERIFY=0` disables for the current run; `CROSSVERIFY=1` enables; `CROSSVERIFY=foreground` enables in foreground (blocking) mode; `CROSSVERIFY=force` enables foreground mode and bypasses disable gates. `CROSSVERIFY_MODEL` overrides the verifier model (default `gpt-5.4`).

### Tamper lock

A verifier that a builder agent can switch off is decoration. The obvious cheat is the builder writing `enabled=0` into the project config to silence its own auditor. Three things close that off:

- Set `lock=1` in the **global** config (`crossverify lock on`) and project configs may only *strengthen*, never weaken. A project-level `enabled=0` is ignored, and so are enforcement downgrades (`mode` foreground→background, `failmode` closed→open) — a builder that can't disable its auditor shouldn't be able to defang it either. Upgrades (background→foreground, open→closed) always apply. Ignored keys are reported explicitly. Only the user, via `crossverify lock off`, can unlock.
- Even with the lock off, an honored project-level disable is always logged. A disable is never silent.
- The verifier's own system prompt, schema, and rule packs live outside the project (global or plugin dir), and the verifier runs read-only. A project can *name* a rule pack; it cannot edit pack contents outside its own repo.

### Fail mode

Default is **fail-open**: if Codex is missing, times out, or returns something that doesn't parse against the schema, the hook logs the failure and lets the builder finish normally. Verifier infrastructure problems should never hold your work hostage. For unattended pipelines that would rather stop than proceed unverified, set `failmode=closed`: a verdict-parse failure then blocks the builder's stop with an infrastructure-error message instead of passing through silently. The same per-session counter applies here too, so even in `failmode=closed` the verifier gives up after 2 attempts and defers rather than blocking forever.

## How this compares

Most code-review automation (CodeRabbit, Greptile, Qodo, PR-Agent) verifies a **diff at the PR boundary**: what changed between two commits, reviewed once, at the end. crossverify verifies **an agent's stated claims at the turn boundary**: every time the builder says "done," its specific claims are checked against reality, while the session is still live and the fix is still cheap. The two are complementary. They answer different questions ("is this diff good?" vs. "did the agent actually do what it just said?").

The closest analog is OpenAI's official [codex-plugin-cc](https://github.com/openai/codex-plugin-cc), also a Claude Code Stop-hook gate that spawns Codex to review the turn. That project has orders of magnitude more users and OpenAI's maintenance behind it. If you want a synchronous, fail-closed review gate, use it. crossverify differs on purpose in four ways: it **decomposes claims** into atomic propositions with per-claim verdicts against a fixed JSON schema, rather than producing one holistic review; it defaults to **background** mode and fails open, so it observes without ever hanging your session; failure criteria live in swappable **rule packs** rather than the prompt; and the builder/verifier pairing is meant to be **vendor-generic**. Codex-checks-Claude is the first pairing, not the identity of the tool.

## What this touches, and how to undo it

Everything this tool writes, and how to remove all of it:

- **Hook.** Plugin install: the Stop hook comes from the plugin's own `hooks/hooks.json`; your `settings.json` is not modified. Manual install (`node install.mjs`): one Stop hook entry is **additively merged** into `~/.claude/settings.json`. Existing hooks are never clobbered, and a `.bak` backup of the file is written before the merge.
- **Config.** Two plain `key=value` files you can read and edit with any editor: global `~/.claude/crossverify/config`, per-project `.claude/crossverify.conf`. No state or reports are ever stored in `settings.json`.
- **Reports.** `<project>/.crossverify/` by default. On first write inside a git repo, `.crossverify/` is appended to your `.gitignore` once (idempotent; skipped outside a repo). Set `output=global` to keep reports in `~/.claude/crossverify/reports/` instead.
- **State and logs.** Always `~/.claude/crossverify/`, the same directory for every install path (plugin or manual), so the Stop hook and the CLI never disagree about where state lives. Attempt counters and `hook.log` live here, never in your project.
- **Statusline.** Never touched. Setup only *prints* the one-liner to add or append the `[VFY]` segment yourself; it never writes the `statusLine` key for you, and it never asks.
- **Undo.** `crossverify uninstall` removes the settings.json hook entry, global config, and global state, printing every path it removed (per-project `.claude/crossverify.conf` and `.crossverify/` stay — delete per project). Plugin installs can also just `/plugin uninstall crossverify`, then remove `~/.claude/crossverify/` by hand.
- **Default off.** Installing does not enable anything. Nothing runs until you turn it on.

## Security

A tool that installs a hook into your coding agent should hold itself to a higher bar than the average npm package. The posture, in order of importance:

- **Zero runtime dependencies.** Node stdlib only. No `dependencies`, no `devDependencies`, no lockfile, no transitive tree to poison. This is both the portability decision and the main supply-chain defense.
- **No lifecycle scripts.** `package.json` has no `postinstall`/`preinstall`/`prepare`. Nothing executes on install; all execution is an explicit user action (`/crossverify:setup`, `node install.mjs`). That lifecycle door is exactly how the 2025-26 npm worms spread.
- **No build step.** The `.mjs` source ships as-is. No bundler, no transpiler, no minification. What you audit is what runs.
- **CI-only publish with provenance.** When the npm package ships, it publishes exclusively from a GitHub Actions workflow using OIDC trusted publishing with `--provenance`, so you can verify the package was built from this repo at this commit. No publish tokens on laptops; Actions pinned by full commit SHA.
- **The git plugin channel is independent of npm.** The primary install path never touches the npm registry, and you can pin the marketplace add to a tag or SHA if you prefer explicit updates over tracking main.

On the consumer side: the verifier runs `--sandbox read-only`, so even a prompt-injected verifier can't write. A verdict that doesn't parse against the fixed schema is discarded (fail-open pass-through). In blocking mode, the feedback text is length-capped and the 2-attempt counter bounds any injected loop. The [tamper lock](#tamper-lock) covers the builder-edits-the-verifier threat.

## License

[MIT](LICENSE).
