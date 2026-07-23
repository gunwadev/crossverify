// lib/transcript.mjs — per-turn mutation gate, ported from the proven bash hook.
//
// Behavior (bash reference: local verifier.sh "per-turn gate", 2026-07-06 fix):
// - sliceLastTurn: find the LAST line matching "type":"user" that does NOT
//   contain "tool_use_id" (tool results are type:user but carry tool_use_id;
//   a genuine human prompt does not) and return that line through EOF.
//   Fallback: no such line -> return the whole text (conservative — prefer a
//   false-positive verify over a false-negative skip).
// - hasMutation: true if the slice contains a Write/Edit/MultiEdit/NotebookEdit
//   tool call, or a Bash tool call plus a match of the mutating-verb regex.

const WRITE_TOOL_RE = /"name":"(Write|Edit|MultiEdit|NotebookEdit)"/;
const BASH_TOOL_RE = /"name":"Bash"/;

// Faithful JS port of mutating_verb_re from the bash hook. Translation notes:
// grep -E scans line by line, so ^ means start-of-line — the 'm' flag preserves
// that; POSIX [[:alnum:]] becomes [a-zA-Z0-9]. Everything else is verbatim.
//
// Windows/PowerShell coverage added on top of the POSIX port: without it, a
// Windows agent's `del`/`Remove-Item`/etc. would silently skip verification
// (a false-negative gate — the worst failure mode for a verifier). The short
// verbs (del, erase, rd, rmdir, move, ren, xcopy, robocopy, mklink) reuse the
// exact same word-bounded shape as the POSIX verbs above (non-alnum-or-start
// on the left, a literal space on the right) so e.g. "model" (contains "del")
// or "guard"/"card" (contain "rd") never match. The PowerShell cmdlets
// (Remove-Item, Move-Item, Copy-Item, New-Item, Set-Content, Add-Content,
// Out-File) are conventionally PascalCase but PowerShell itself is
// case-insensitive, so the whole regex now carries the 'i' flag. That
// intentionally widens the existing POSIX alternatives too (bare "RM" etc.
// now also matches) — accepted as a conservative trade-off: a false-positive
// verify (checked when not strictly necessary) is safe by design, a
// false-negative skip is not.
const MUTATING_VERB_RE = new RegExp(
  '(git (commit|push|merge|rebase|reset|apply|stash)' +
    '|(^|[^a-zA-Z0-9])(rm|mv|cp|mkdir|touch|chmod|chown|ln|dd|kill|truncate' +
      '|del|erase|rd|rmdir|move|ren|xcopy|robocopy|mklink) ' +
    '|sed[^"]*-i' +
    '|>>' +
    '|[^<]> [^&]' +
    '|tee ' +
    '|npm (install|ci|run|uninstall)' +
    '|yarn (add|install|remove)' +
    '|pnpm (add|install|remove)' +
    '|pip3? install' +
    '|brew install' +
    '|apt(-get)? install' +
    '|cargo install' +
    '|go install' +
    '|make install' +
    '|curl[^"]*-o ' +
    '|wget ' +
    '|patch ' +
    '|launchctl ' +
    '|defaults write' +
    '|xargs rm' +
    '|find[^"]*-delete' +
    '|(^|[^a-zA-Z0-9])(Remove-Item|Move-Item|Copy-Item|New-Item|Set-Content|Add-Content|Out-File) )',
  'mi',
);

export function sliceLastTurn(text) {
  const lines = text.split('\n');
  let lastUserIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('"type":"user"') && !lines[i].includes('"tool_use_id"')) {
      lastUserIdx = i;
    }
  }
  if (lastUserIdx === -1) return text;
  return lines.slice(lastUserIdx).join('\n');
}

export function hasMutation(slice) {
  if (WRITE_TOOL_RE.test(slice)) return true;
  if (BASH_TOOL_RE.test(slice)) return MUTATING_VERB_RE.test(slice);
  return false;
}
