import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const skillPath = path.join(repoRoot, 'plugin', 'skills', 'crossverify', 'SKILL.md');
const snippetPath = path.join(repoRoot, 'docs', 'claude-md-snippet.md');

const REQUIRED_TRIGGER_PHRASES = [
  'turn on the verifier',
  'verify status',
  'show the last verifier report',
  "why can't the agent stop",
  'verifier blocked my agent',
  'what did the verifier say',
  'turn off verification here',
  'disable crossverify',
];

const REQUIRED_BODY_HEADINGS = [
  '## What crossverify is',
  '## CLI invocations',
  '## How to read a report',
  '## File locations',
  '## Anti-instructions',
  '## Lock',
  '## Two reviewers',
  '### How to invoke the second reviewer',
  '### Which vendor decides',
  '## Gap analysis',
];

const REQUIRED_REPORT_FIELDS = [
  'status',
  'confidence',
  'claims_total',
  'claims_verified',
  'claims_failed',
  'claims_unverified',
  'feedback',
  'needs_from_user',
  'gaps',
  'second',
];

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, 'SKILL.md must start with a --- frontmatter block');
  const frontmatter = new Map();
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    frontmatter.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return { frontmatter, body: match[2] };
}

test('SKILL.md has name: crossverify frontmatter', () => {
  const text = readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');
  const { frontmatter } = parseFrontmatter(text);
  assert.equal(frontmatter.get('name'), 'crossverify');
});

test('SKILL.md description includes every required trigger phrase', () => {
  const text = readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');
  const { frontmatter } = parseFrontmatter(text);
  const description = frontmatter.get('description') ?? '';
  for (const phrase of REQUIRED_TRIGGER_PHRASES) {
    assert.ok(description.includes(phrase), `description missing trigger phrase: "${phrase}"`);
  }
});

test('SKILL.md body has every required section heading', () => {
  const text = readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');
  const { body } = parseFrontmatter(text);
  for (const heading of REQUIRED_BODY_HEADINGS) {
    assert.ok(body.includes(heading), `body missing heading: "${heading}"`);
  }
});

test('SKILL.md body carries the never-disable-to-escape-a-block anti-instruction', () => {
  const text = readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(
    text.includes('NEVER disable verification'),
    'body missing the never-disable-to-escape-a-block anti-instruction'
  );
});

test('SKILL.md body documents every report JSON field', () => {
  const text = readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');
  for (const field of REQUIRED_REPORT_FIELDS) {
    assert.ok(text.includes(field), `body missing report field: "${field}"`);
  }
});

test('docs/claude-md-snippet.md is 5 lines or fewer', () => {
  const text = readFileSync(snippetPath, 'utf8').replace(/\r\n/g, '\n');
  const rawLines = text.split('\n');
  const lines = rawLines.filter((line, i) => !(i === rawLines.length - 1 && line === ''));
  assert.ok(lines.length <= 5, `snippet has ${lines.length} lines, expected <= 5`);
});

test('docs/claude-md-snippet.md mentions crossverify and a CLI invocation', () => {
  const text = readFileSync(snippetPath, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(text.includes('crossverify'), 'snippet must mention crossverify');
  assert.ok(
    text.includes('crossverify status') || text.includes('crossverify report'),
    'snippet must show at least one crossverify CLI invocation'
  );
});

test('SKILL.md teaches the availability playbook and on-demand invocation', () => {
  const text = readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');
  for (const needle of [
    'crossverify second now',
    'crossverify second check',
    'CROSSVERIFY_SECOND=1',
    'CROSSVERIFY_SECOND_MODEL',
    'second.promoted',
    'primary_error',
    'second.status: "error"',
    'both reviewers failed',
    'hollow',
    'hook.log',
    'rate-limited',
  ]) {
    assert.ok(text.includes(needle), `SKILL.md missing: ${needle}`);
  }
});
