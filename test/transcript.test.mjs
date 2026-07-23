import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceLastTurn, hasMutation } from '../plugin/scripts/lib/transcript.mjs';

// --- JSONL fixture builders (shape mirrors real Claude Code transcripts) ---

function userPrompt(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

function toolResult(id) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  });
}

function assistantText(text) {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

function assistantTool(name, input) {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01A', name, input }] },
  });
}

function jsonl(...lines) {
  return lines.join('\n') + '\n';
}

// --- tests ---

test('pure Q&A turn -> no mutation', () => {
  const fx = jsonl(
    userPrompt('what does the config module do?'),
    assistantText('It resolves settings with env over project over global precedence.'),
  );
  assert.equal(hasMutation(sliceLastTurn(fx)), false);
});

test('turn with Write tool call -> mutation', () => {
  const fx = jsonl(
    userPrompt('create a hello file'),
    assistantTool('Write', { file_path: 'hello.txt', content: 'hi' }),
    toolResult('toolu_01A'),
    assistantText('Created hello.txt.'),
  );
  assert.equal(hasMutation(sliceLastTurn(fx)), true);
});

test('earlier-turn Edit but last turn Q&A -> no mutation (per-turn fix)', () => {
  const followUp = userPrompt('thanks — now explain what that function does');
  const fx = jsonl(
    userPrompt('fix the off-by-one bug'),
    assistantTool('Edit', { file_path: 'app.mjs', old_string: 'i <= n', new_string: 'i < n' }),
    toolResult('toolu_01A'),
    assistantText('Fixed the loop bound.'),
    followUp,
    assistantText('It iterates the items and sums them.'),
  );
  const slice = sliceLastTurn(fx);
  assert.ok(slice.startsWith(followUp), 'slice must start at the last genuine user prompt');
  assert.ok(!slice.includes('"name":"Edit"'), 'earlier-turn Edit must be outside the slice');
  assert.equal(hasMutation(slice), false);
});

test('Bash "git commit" -> mutation', () => {
  const fx = jsonl(
    userPrompt('commit the change'),
    assistantTool('Bash', { command: 'git commit -m "fix loop bound"' }),
    toolResult('toolu_01A'),
    assistantText('Committed.'),
  );
  assert.equal(hasMutation(sliceLastTurn(fx)), true);
});

test('Bash "ls -la" -> no mutation', () => {
  const fx = jsonl(
    userPrompt('show me the files here'),
    assistantTool('Bash', { command: 'ls -la' }),
    toolResult('toolu_01A'),
    assistantText('Listed the directory contents.'),
  );
  assert.equal(hasMutation(sliceLastTurn(fx)), false);
});

// --- table-driven coverage of the mutating-verb regex, via Bash tool calls ---

function bashTurn(command) {
  return jsonl(
    userPrompt('run a command'),
    assistantTool('Bash', { command }),
    toolResult('toolu_01A'),
  );
}

const MUTATING_COMMANDS = [
  'rm -rf build',
  'mv a.txt b.txt',
  'cp a.txt b.txt',
  'mkdir newdir',
  'touch newfile',
  'chmod +x script.sh',
  'sed -i s/a/b/ file.txt',
  'echo hi >> out.txt',
  'echo hi > out.txt',
  'ls | tee out.txt',
  'npm install lodash',
  'pip install requests',
  'brew install jq',
  'cargo install ripgrep',
  'git push origin main',
  'git merge feature-branch',
  'find . -name pattern -delete',
  'find . -name pattern | xargs rm',
  // Windows/PowerShell mutating verbs (I4): a Windows agent's del/Remove-Item/
  // etc. must not silently escape verification.
  'del file.txt',
  'erase file.txt',
  'rd /s /q olddir',
  'rmdir /s /q olddir',
  'move a.txt b.txt',
  'ren a.txt b.txt',
  'xcopy a b /e',
  'robocopy src dst /mir',
  'mklink link target',
  'Remove-Item file.txt',
  'Move-Item a.txt b.txt',
  'Copy-Item a.txt b.txt',
  'New-Item -Path file.txt -ItemType file',
  'Set-Content file.txt "hi"',
  'Add-Content file.txt "more"',
  'Out-File -FilePath file.txt',
  // case-insensitivity ('i' flag, I4): PowerShell cmdlets aren't case-sensitive.
  'remove-item file.txt',
];

const NON_MUTATING_COMMANDS = [
  'ls',
  'cat file.txt',
  'grep -r foo .',
  'git status',
  'git diff',
  'echo hi',
  // Word-boundary regression checks (I4): these contain a mutating verb as a
  // SUBSTRING but must not match — the gate must not false-negative on
  // prose, but it also must never false-positive on innocent words.
  'delete this paragraph please', // "del" not followed by a space -> no match
  'rename the model file', // "model" contains "del" preceded by a word char -> no match
];

for (const command of MUTATING_COMMANDS) {
  test(`mutating verb regex: "${command}" -> mutation`, () => {
    assert.equal(hasMutation(sliceLastTurn(bashTurn(command))), true);
  });
}

for (const command of NON_MUTATING_COMMANDS) {
  test(`mutating verb regex: "${command}" -> no mutation`, () => {
    assert.equal(hasMutation(sliceLastTurn(bashTurn(command))), false);
  });
}

test('no genuine user line -> fallback scans whole text', () => {
  const fx = jsonl(
    toolResult('toolu_00Z'),
    assistantTool('Edit', { file_path: 'app.mjs', old_string: 'a', new_string: 'b' }),
    toolResult('toolu_01A'),
  );
  assert.equal(sliceLastTurn(fx), fx);
  assert.equal(hasMutation(sliceLastTurn(fx)), true);
});

// Dogfood 2026-07-22: a verifier report blamed slice truncation on the
// AskUserQuestion answer. Investigation proved the OPPOSITE — those answers
// are tool_result entries carrying tool_use_id, so the slice correctly keeps
// the turn intact across them. Pin that so it can never silently regress.
test('sliceLastTurn: AskUserQuestion tool_result does not start a new turn', () => {
  const t = [
    '{"type":"user","message":{"role":"user","content":"do two things"}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"first.sh"}}]}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"AskUserQuestion","input":{"questions":[]}}]}}',
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Your questions have been answered","tool_use_id":"toolu_x"}]}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"second.sh"}}]}}',
  ].join('\n');
  const slice = sliceLastTurn(t);
  assert.ok(slice.includes('first.sh'), 'work BEFORE the AskUserQuestion answer must stay in the slice');
  assert.ok(slice.includes('do two things'), 'slice must start at the genuine user prompt');
});
