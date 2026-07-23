# Security Policy

crossverify installs a Stop hook into your coding agent, so it holds itself
to a higher bar than the average dev tool — see the [Security section of the
README](README.md#security) for the full posture (zero dependencies, no
lifecycle scripts, no build step, read-only verifier sandbox).

## Reporting a vulnerability

Open a [GitHub security advisory](../../security/advisories/new) (private
disclosure), or if that is unavailable, open an issue that says only "security
report — requesting contact" without details and a maintainer will respond.

Please include: the file/commit affected, a reproduction, and the impact you
believe it has. Reports against the threat model the README documents (a
builder agent tampering with its own verifier, hook escape, sandbox escape,
prompt injection through transcripts) are especially welcome.

## Scope

The `plugin/` tree and `install.mjs` as shipped in this repository. The Codex
CLI itself, Claude Code itself, and your own rule packs are out of scope here
— report those upstream.
