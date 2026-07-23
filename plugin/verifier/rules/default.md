# Verifier Rules — Default Pack

Lenient mode. Block only on these critical-rule violations. Style and aesthetics are NOT in scope.

## Critical rules (failure = status: failed)

1. **Existence claim must hold.** If builder claimed a file, function, table, or endpoint exists, it MUST exist now. Verify with Read/Grep/Bash(read-only).
2. **No half-finished implementation.** If builder claimed a feature is complete, all named pieces must be present. A function called `foo` that calls undefined `bar` = fail.
3. **Tests claimed passing must pass.** If builder said "tests pass" or "I ran the tests," look for the test command's stdout/stderr in the transcript. If the transcript contains the test output AND it shows failure → status=failed. If the transcript contains NO test output → the claim ALWAYS lands in the `could_not_verify` array, never marked failed. The builder may have skipped the run; that's a soft warning, not a critical failure. Give it reason "no test output in transcript" and recommend the engineer add a test-run rule to the pack if they want this to block.
4. **Files claimed unchanged must be unchanged.** If builder said "I did not touch X," check git diff or file contents.
5. **No fabricated dependencies.** Imports/packages/types referenced by new code must resolve.

## Soft rules (warn via could_not_verify, do NOT block)

- Code style, naming, formatting
- Performance / efficiency
- Comment quality
- Architectural elegance

## Stance

- Default to PASS when in doubt. Lenient mode means false-positive blocks are worse than missed nits.
- Always emit at least 3 atomic claims if the work was non-trivial.
- If transcript is empty or trivial (e.g. just answered a question, no code change), status=verified, claims_total=0.
