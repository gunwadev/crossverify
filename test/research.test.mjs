// test/research.test.mjs — the search-isolated pass's programmatic gates:
// topic sanitization (the egress filter) and verdict merge/escalation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTopics, buildResearchPrompt } from '../plugin/scripts/lib/research.mjs';

test('sanitizeTopics: caps at 3, trims, drops empties and non-strings', () => {
  const out = sanitizeTopics(['  node lts version  ', '', 42, 'react 19 server actions', 'x', 'four', 'five']);
  assert.deepEqual(out, ['node lts version', 'react 19 server actions', 'x']);
});

test('sanitizeTopics: drops secret-shaped topics (any unbroken token >= 20 chars)', () => {
  const out = sanitizeTopics([
    'is the sky blue',
    'key sk-abcdefghijklmnopqrstuvwx leaked',      // API-key shaped
    'value MYSECRETPASSWORDTOKEN12345',              // long token
    '/Users/someone/project/.env contents here abcdefghijklmnop', // long path token
  ]);
  assert.deepEqual(out, ['is the sky blue']);
});

test('sanitizeTopics: drops over-long topics and tolerates junk input', () => {
  assert.deepEqual(sanitizeTopics(['a'.repeat(30) + ' b']), []); // 30-char token
  assert.deepEqual(sanitizeTopics(['x '.repeat(60)]), []);       // > 80 chars total
  assert.deepEqual(sanitizeTopics(null), []);
  assert.deepEqual(sanitizeTopics('not an array'), []);
});

test('buildResearchPrompt: numbered topics, no repo/transcript references', () => {
  const p = buildResearchPrompt(['node current version', 'react latest major']);
  assert.match(p, /1\. node current version/);
  assert.match(p, /2\. react latest major/);
  assert.match(p, /NO other context/);
  assert.doesNotMatch(p, /TRANSCRIPT|WORKING_DIR|RULES/);
});
