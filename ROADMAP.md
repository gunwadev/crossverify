# Roadmap

Post-v1 direction, roughly in order. Informed by three months of dogfooding
and a structured design review; reordered freely as real-world usage lands.
Nothing here is a promise with a date.

## 1. Fail-open watchdog + `crossverify doctor`

Fail-open is the right default, but its failure mode is silence: codex
uninstalled, auth expired, repeated timeouts — and the verifier quietly never
runs while you believe you're covered. Planned: a reason-code ledger for
every skipped run, a consecutive-coverage-gap counter that flips the
statusline to a loud "verifier hasn't run in N turns" state, a positive
heartbeat ("verified 2 turns ago") even when green, and `crossverify doctor`
to probe codex/auth/assets and print the top skip reasons.

## 2. Evidence piggybacking (cheaper, faster verification)

The turn transcript often already contains proof: real test output, tool
results, exit codes. Pre-scan the slice; claims whose receipts are present
(harness-authored tool results only — never the builder's own prose, with
receipts void if a later edit touched their files) let the verifier focus
its budget on the receiptless claims. Full skip only after an adversarial
audit-sampling phase measures the false-pass rate.

## 3. Claim → assertion compiler (verification that accumulates)

The verifier already runs concrete shell probes per claim. Emit them as
structured `{command, expected}` assertions, persist per project, and replay
them in milliseconds on later turns — a turn-5 edit that breaks a turn-2
claim gets caught without an LLM call. Side effect: the project accumulates
a verifier-authored regression suite (`crossverify export` → a runnable
node:test file). Gated on a false-alarm measurement pass first.

## 4. Known verification gaps to close

- **Turn-split dodge**: act in one turn, claim in the next — the slice never
  contains both. Needs cross-turn claim tracking.
- **Phrasing dodge**: hedged wordings ("should now work") that escape claim
  decomposition. Map the grammar, pin it in the rule pack.
- **Pathological turns**: giant transcripts/binary blobs should degrade to a
  labeled skip, never a crash.

## 5. Smaller items

- `crossverify verify` — re-verify the last turn on demand.
- Real npm package with a `crossverify` bin (`npx crossverify init`),
  published with provenance from CI.
- Report provenance stamps (rule-pack hash, codex version, prompt revision).
- Statusline indicator while research pass 2 runs.
- Native Windows lane when the upstream codex sandbox fix lands.

## Explicitly not planned

- Same-vendor verification as a default (defeats the point).
- A verifier with write access to your project (read-only is the trust
  contract; feedback flows only through the builder).
- Dependencies. The zero-dep, no-build, read-it-in-a-sitting posture stays.
