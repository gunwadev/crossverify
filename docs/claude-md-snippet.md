## Verification

This project runs **crossverify**, a Stop-hook verifier that checks turns with a separate AI vendor (Codex, read-only). See `.claude/crossverify.conf`.
Reports also list **gaps** (missing/fragile things, advisory) and, when enabled, a **second reviewer's** verdict. If a turn is blocked, run `crossverify report --json` (if `crossverify` is not on PATH: `node "<plugin-or-clone>/plugin/scripts/cli.mjs" report --json`), fix the failed claims, and let the hook re-check — never disable the verifier or weaken its config to get past a block.
Check status any time: `crossverify status` (same PATH fallback).
