// lib/transcript.mjs — per-turn mutation gate, ported from the proven bash hook.
//
// Behavior (bash reference: local verifier.sh "per-turn gate", 2026-07-06 fix):
// - sliceLastTurn: find the LAST line matching "type":"user" that does NOT
//   contain "tool_use_id" (tool results are type:user but carry tool_use_id;
//   a genuine human prompt does not) and return that line through EOF.
//   Fallback: no such line -> return the whole text (conservative — prefer a
//   false-positive verify over a false-negative skip).
// - hasMutation: true if the slice contains a Write/Edit/MultiEdit/NotebookEdit
//   tool call, or a Bash tool call whose command is not provably read-only
//   (allowlist — see READ_ONLY below; unknown commands count as mutations).

const WRITE_TOOL_RE = /"name":"(Write|Edit|MultiEdit|NotebookEdit)"/;
const BASH_TOOL_RE = /"name":"Bash"/;

// The gate is an ALLOWLIST: anything not proven read-only counts as a
// mutation. The previous denylist of mutating verbs let a builder skip its own
// auditor by writing files through an interpreter — `node -e`, `python3 -c`,
// `perl -pi`, plus plain misses like `git checkout -- .` and `install`, all
// scored "no mutation" and verification never ran. Since this gate exists only
// to save a codex call, the safe direction is a needless verify, never a
// silent skip.
const READ_ONLY = new Set([
  'ls', 'cat', 'bat', 'head', 'tail', 'wc', 'grep', 'rg', 'ag', 'find', 'fd', 'pwd', 'echo',
  'printf', 'which', 'type', 'whoami', 'id', 'hostname', 'date', 'uname', 'env', 'printenv',
  'sort', 'uniq', 'cut', 'tr', 'column', 'diff', 'file', 'stat', 'du', 'df', 'tree', 'jq', 'yq',
  'basename', 'dirname', 'realpath', 'readlink', 'sleep', 'true', 'false', 'test', 'node', 'npx',
  'python', 'python3', 'go', 'cargo', 'ruby', 'java', 'dotnet', 'tsc', 'curl', 'wget', 'ping',
  'dig', 'host', 'nc', 'ps', 'top', 'git', 'npm', 'pnpm', 'yarn', 'docker', 'kubectl', 'gh',
  'man', 'help', 'history', 'tldr', 'less', 'more',
]);

// Binaries that are read-only only in certain modes.
const SUBCOMMANDS = {
  git: new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'ls-files',
    'blame', 'describe', 'tag', 'config', 'shortlog', 'grep', 'cat-file', 'symbolic-ref',
    'worktree']),
  npm: new Set(['ls', 'list', 'view', 'info', 'test', 'why', 'outdated', 'ping', 'whoami', 'root',
    'prefix', 'config']),
  pnpm: new Set(['ls', 'list', 'view', 'info', 'test', 'why', 'outdated', 'root']),
  yarn: new Set(['list', 'info', 'why', 'test', 'versions']),
  docker: new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info', 'port', 'top', 'stats',
    'diff']),
  kubectl: new Set(['get', 'describe', 'logs', 'explain', 'version', 'top', 'api-resources',
    'config']),
  gh: new Set(['pr', 'issue', 'repo', 'run', 'api', 'auth', 'release', 'search', 'workflow']),
  cargo: new Set(['check', 'tree', 'metadata', 'search', '--version', 'fmt']),
  go: new Set(['version', 'list', 'vet', 'env', 'doc']),
};

// Flags that turn an otherwise read-only binary into a writer.
const WRITING_FLAG_RE =
  /(^|\s)(-o|--output|-O|--output-document|-w|--write|-i|--in-place|--fix|-e|--eval|-c|--command|-p|-delete|-exec|-execdir|-ok|-okdir)(\s|=|$)/;
const REDIRECT_RE = /(^|[^0-9<>])>{1,2}[^&]|(^|\s)\|\s*tee(\s|$)/;

// Pull the actual Bash commands out of the slice. Returns null when they can't
// be read, and the caller then assumes a mutation rather than guessing.
function bashCommands(slice) {
  const found = [];
  for (const line of slice.split('\n')) {
    if (!BASH_TOOL_RE.test(line)) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return null;
    }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) return null;
    for (const block of content) {
      if (block?.type === 'tool_use' && block?.name === 'Bash') {
        if (typeof block?.input?.command !== 'string') return null;
        found.push(block.input.command);
      }
    }
  }
  return found;
}

function segmentMutates(seg) {
  const s = seg.trim();
  if (s === '') return false;
  if (REDIRECT_RE.test(s)) return true;
  const tokens = s.split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++; // VAR=x prefix
  const bin = (tokens[i] || '').replace(/^.*[\\/]/, '').toLowerCase();
  if (!READ_ONLY.has(bin)) return true;
  if (SUBCOMMANDS[bin] && !SUBCOMMANDS[bin].has((tokens[i + 1] || '').toLowerCase())) return true;
  if (WRITING_FLAG_RE.test(s)) return true;
  return false;
}

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
  if (!BASH_TOOL_RE.test(slice)) return false;
  const cmds = bashCommands(slice);
  if (cmds === null) return true; // couldn't read the commands -> verify
  return cmds.some((cmd) => cmd.split(/\|\||&&|[;&|\n]/).some(segmentMutates));
}
