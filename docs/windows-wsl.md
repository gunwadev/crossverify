# crossverify on Windows via WSL

Until the Codex CLI's native Windows read-only sandbox is fixed upstream
(openai/codex [#31744](https://github.com/openai/codex/issues/31744),
[#32655](https://github.com/openai/codex/issues/32655),
[#20919](https://github.com/openai/codex/issues/20919)), verification on
Windows runs through WSL. Everything else about crossverify — the Stop hook,
CLI, config, reports — runs natively on Windows.

## 0. Install WSL (skip if you have it)

Follow Microsoft's guide: <https://learn.microsoft.com/en-us/windows/wsl/install>

In short, in an **administrator** PowerShell:

```powershell
wsl --install
```

Reboot when prompted. This installs WSL2 with Ubuntu by default.

## 1. Install Node and Codex inside WSL

Open Ubuntu (type `wsl` in any terminal) and run:

```bash
# Node 18+ — Ubuntu 24.04's apt version is fine; or use nvm if you prefer
sudo apt-get update && sudo apt-get install -y nodejs npm

# Codex CLI — the platform binary ships as an optional dependency; make sure
# npm actually installs it (a known npm quirk silently skips it otherwise).
# sudo needed with apt's node: the global npm prefix is root-owned. (nvm
# users: drop the sudo.)
sudo npm install -g @openai/codex
cd "$(npm root -g)/@openai/codex" && sudo npm install --include=optional

codex --version   # should print codex-cli <version>
```

## 2. Share your Codex login with WSL

Logging in from inside WSL often fails at the OAuth step (known issue), so
log in on Windows first (`codex login` in PowerShell, or the Codex desktop
app), then copy the credential file into WSL:

```bash
mkdir -p ~/.codex
cp /mnt/c/Users/<YOUR-WINDOWS-USER>/.codex/auth.json ~/.codex/auth.json
```

## 3. Verify it works

```bash
mkdir -p ~/cv-check && echo hi > ~/cv-check/canary.txt
codex exec --sandbox read-only --skip-git-repo-check --cd ~/cv-check --color never \
  "Run a directory listing and reply ONLY with the word TOOLS-WORK followed by the filenames you saw, or TOOLS-BLOCKED followed by the error"
```

You want a final line like `TOOLS-WORK canary.txt`. That is Codex actually
reading your disk under a kernel-enforced (Landlock) read-only sandbox — the
same guarantee crossverify relies on. If you see `TOOLS-BLOCKED`, re-check
steps 1-2.

## Notes

- Keep repositories you want verified reachable from WSL. Repos on the
  Windows filesystem are visible at `/mnt/c/...` (works, slightly slower);
  repos inside the WSL filesystem are fastest.
- When the upstream native-Windows sandbox fix ships, crossverify needs no
  changes — the hook already resolves and runs Codex natively; it is only
  Codex's sandbox runner that is currently broken there.
- If a verification on native Windows can't observe anything, the report's
  `windows_hint` field says so explicitly with the checks to run — you will
  never get a silently useless verdict.
