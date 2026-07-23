#!/usr/bin/env bash
# scripts/e2e-pipeline.sh — run the real-codex E2E on every configured machine.
# Local network pipeline: mac (local) first, then each SSH host in E2E_HOSTS.
#
# Usage:
#   ./scripts/e2e-pipeline.sh                       # local only
#   E2E_HOSTS="user@host1 user@host2" ./scripts/e2e-pipeline.sh
#   E2E_HOSTS="wsl:user@host1" ./scripts/e2e-pipeline.sh   # run inside host's WSL
#   E2E_SKIP_LOCAL=1 E2E_HOSTS=... ./scripts/e2e-pipeline.sh
#
# Host entries: `user@host` runs natively (Windows/PowerShell assumed);
# `wsl:user@host` runs inside that host's WSL distro (the default distro, or
# E2E_WSL_DISTRO to pick one). WSL is the supported verification lane on
# Windows until the upstream codex native-sandbox bug is fixed (see README
# "Windows: use WSL for now") — the native lane is expected to FAIL its
# lying scenario there.
#
# Native Windows hosts need: node + codex on the SSH session PATH, or set
# E2E_WIN_PATH to prepend (semicolon-free, one dir per entry, comma-separated).
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail=0

if [ -n "${E2E_SKIP_LOCAL:-}" ]; then
  echo "==== E2E [local: skipped (E2E_SKIP_LOCAL set)] ===="
else
  echo "==== E2E [local: $(uname -s)] ===="
  if node e2e/real-codex.e2e.mjs; then
    echo "==== local: PASS ===="
  else
    rc=$?
    if [ "$rc" = "2" ]; then echo "==== local: SKIPPED (codex not installed/authenticated) ===="
    else echo "==== local: FAIL ===="; fail=1; fi
  fi
fi

for entry in ${E2E_HOSTS:-}; do
  lane=native
  host="$entry"
  case "$entry" in
    wsl:*) lane=wsl; host="${entry#wsl:}" ;;
  esac
  echo "==== E2E [remote: $host ($lane)] ===="
  # Ship current HEAD as a bundle; clone fresh on the remote; run.
  bundle="/tmp/cv-e2e-$$.bundle"
  git bundle create "$bundle" main >/dev/null 2>&1
  scp -q "$bundle" "$host":cv-e2e.bundle
  rm -f "$bundle"

  if [ "$lane" = "wsl" ]; then
    # WSL lane. The runner script is embedded as base64 in argv, NOT piped
    # via ssh stdin: stdin through Windows OpenSSH -> PowerShell -> wsl can
    # be silently dropped (observed live: bash got EOF, exited 0, lane
    # reported a false PASS with zero scenario output). base64 is
    # [A-Za-z0-9+/=] only, so it survives the nested PowerShell/bash quoting.
    # The bundle scp'd above lands in the Windows profile dir; resolve it
    # from inside WSL via cmd.exe interop.
    wsl_cmd="wsl"
    if [ -n "${E2E_WSL_DISTRO:-}" ]; then wsl_cmd="wsl -d ${E2E_WSL_DISTRO}"; fi
    # Warm the distro first: cold-booted wsl.exe intermittently returns 0
    # WITHOUT executing the command (observed live, repeatedly). First contact
    # must be a throwaway, and an empty-output run below is treated as a
    # failure, never a pass.
    ssh -o BatchMode=yes "$host" "$wsl_cmd -- bash -lc 'echo warmed'" </dev/null >/dev/null 2>&1 || true
    sleep 3
    wsl_b64=$(base64 <<'WSL_EOF' | tr -d '\n'
set -e
WINHOME=$(wslpath "$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')")
rm -rf ~/cv-e2e-run
git clone -q -b main "$WINHOME/cv-e2e.bundle" ~/cv-e2e-run
cd ~/cv-e2e-run
node e2e/real-codex.e2e.mjs
WSL_EOF
)
    wsl_out="$(ssh -o BatchMode=yes "$host" "$wsl_cmd -- bash -lc 'echo $wsl_b64 | base64 -d | bash'" </dev/null 2>&1)"
    rc=$?
    printf '%s\n' "$wsl_out"
    if [ -z "$wsl_out" ]; then
      echo "==== $host (wsl): silent no-op (empty output) — treating as FAIL ===="
      rc=1
    fi
  else
    # Native lane, Windows/PowerShell assumed (extend per-host as the fleet
    # grows). No default for E2E_WIN_PATH: it is machine-specific (never
    # hardcode a personal path in the repo). Unset means node + codex must
    # already be on the remote SSH session's PATH.
    path_prefix=""
    if [ -n "${E2E_WIN_PATH:-}" ]; then
      path_prefix="\$dirs = '${E2E_WIN_PATH}' -split ','; \$env:Path = (\$dirs -join ';') + ';' + \$env:Path; "
    fi
    ssh -o BatchMode=yes "$host" "${path_prefix}Remove-Item -Recurse -Force cv-e2e-run -ErrorAction SilentlyContinue; git clone -q cv-e2e.bundle cv-e2e-run; cd cv-e2e-run; node e2e/real-codex.e2e.mjs"
    rc=$?
  fi

  if [ "$rc" = "0" ]; then echo "==== $host ($lane): PASS ===="
  elif [ "$rc" = "2" ]; then echo "==== $host ($lane): SKIPPED (codex not installed/authenticated there) ===="
  else echo "==== $host ($lane): FAIL ===="; fail=1; fi
done

exit $fail
