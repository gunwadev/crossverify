// test/merge.test.mjs — merging the primary verdict with the second
// (independent, different-provider) reviewer's verdict, and gap handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeVerdicts, sanitizeGaps } from '../plugin/scripts/lib/merge.mjs';

const base = (over) => ({
  status: 'verified', confidence: 'VERIFIED', claims_total: 1, claims_verified: 1,
  claims_failed: 0, claims_unverified: 0, verified: [{ claim: 'a', evidence: 'x' }],
  failed: [], could_not_verify: [], external_claims: [], feedback: '', needs_from_user: '', gaps: [],
  ...over,
});

test('mergeVerdicts: second reviewer agreeing leaves the verdict untouched except for the record', () => {
  const out = mergeVerdicts(base(), base(), { model: 'firerouter' });
  assert.equal(out.status, 'verified');
  assert.equal(out.second.model, 'firerouter');
  assert.equal(out.second.status, 'verified');
  assert.equal(out.second.agreed, true);
});

test('mergeVerdicts: second reviewer with concrete failures escalates unsure to failed', () => {
  const primary = base({ status: 'unsure', confidence: 'PARTIAL' });
  const second = base({
    status: 'failed', confidence: 'FEEDBACK', claims_failed: 1,
    failed: [{ claim: 'b exists', evidence: 'b missing' }], feedback: 'create b',
  });
  const out = mergeVerdicts(primary, second, { model: 'firerouter' });
  assert.equal(out.status, 'failed');
  assert.equal(out.claims_failed, 1);
  assert.deepEqual(out.failed, [{ claim: 'b exists', evidence: 'b missing' }]);
  assert.match(out.feedback, /Second reviewer \(firerouter\) found:/);
  assert.match(out.feedback, /create b/);
  assert.equal(out.second.agreed, false);
});

test('mergeVerdicts: second reviewer failing a verified primary downgrades to unsure, never blocks on its own', () => {
  const primary = base();
  const second = base({
    status: 'failed', claims_failed: 1,
    failed: [{ claim: 'c', evidence: 'nope' }], feedback: 'fix c',
  });
  const out = mergeVerdicts(primary, second, { model: 'firerouter' });
  assert.equal(out.status, 'unsure');
  assert.equal(out.confidence, 'PARTIAL');
  assert.match(out.needs_from_user, /Reviewers disagree/);
  assert.equal(out.feedback, '', 'a disagreement must not produce a block');
  assert.equal(out.second.agreed, false);
});

test('mergeVerdicts: second reviewer never downgrades a failed primary', () => {
  const primary = base({ status: 'failed', claims_failed: 1, failed: [{ claim: 'a', evidence: 'x' }], feedback: 'fix a' });
  const out = mergeVerdicts(primary, base(), { model: 'firerouter' });
  assert.equal(out.status, 'failed');
  assert.equal(out.feedback, 'fix a');
});

test('mergeVerdicts: second reviewer failure (no verdict) is recorded, verdict unchanged', () => {
  const out = mergeVerdicts(base(), null, { model: 'firerouter', error: 'codex exited with code 1' });
  assert.equal(out.status, 'verified');
  assert.equal(out.second.status, 'error');
  assert.match(out.second.error, /exited with code 1/);
});

test('mergeVerdicts: unions gaps from both reviewers, de-duplicated by text', () => {
  const g1 = { gap: 'no retry on timeout', classification: 'CONFIRMED', evidence: 'codex.mjs:40', fix: 'add retry' };
  const g2 = { gap: 'no retry on timeout', classification: 'CONFIRMED', evidence: 'codex.mjs:40', fix: 'add retry' };
  const g3 = { gap: 'unbounded log file', classification: 'OPEN_QUESTION', evidence: 'config.mjs log()', fix: 'rotate' };
  const out = mergeVerdicts(base({ gaps: [g1] }), base({ gaps: [g2, g3] }), { model: 'firerouter' });
  assert.equal(out.gaps.length, 2);
});

test('sanitizeGaps: drops entries without evidence, unknown classification, caps at 10 and caps text', () => {
  const out = sanitizeGaps([
    { gap: 'ok', classification: 'CONFIRMED', evidence: 'f:1', fix: 'x' },
    { gap: 'no evidence', classification: 'CONFIRMED', evidence: '', fix: 'x' },
    { gap: 'bad class', classification: 'GUESS', evidence: 'f:2', fix: 'x' },
    { gap: 'q', classification: 'OPEN_QUESTION', evidence: 'would need runtime check', fix: 'x'.repeat(900) },
    'junk', null,
    ...Array.from({ length: 12 }, (_, i) => ({ gap: `g${i}`, classification: 'CONFIRMED', evidence: 'e', fix: 'f' })),
  ]);
  assert.equal(out.length, 10);
  assert.equal(out[0].gap, 'ok');
  assert.equal(out[1].gap, 'q');
  assert.ok(out[1].fix.length <= 300);
  assert.deepEqual(sanitizeGaps(undefined), []);
});

test('summarizeError keeps the last ERROR line, one line, capped', async () => {
  const { summarizeError } = await import('../plugin/scripts/lib/merge.mjs');
  const raw = 'codex exited with code 1 | stderr: RULES: /x/rules.md\nATTEMPT: 1 of 2\nERROR: You hit your usage limit. Try again Oct 9.\nERROR: You hit your usage limit. Try again Oct 9.';
  assert.equal(summarizeError(raw), 'codex exited with code 1: You hit your usage limit. Try again Oct 9.');
  assert.equal(summarizeError('codex timed out after 180000ms'), 'codex timed out after 180000ms');
  assert.ok(summarizeError('x'.repeat(900)).length <= 300);
  assert.equal(summarizeError(undefined), 'unknown error');
});

test('isHollow: unsure with zero claims on a turn that had mutations', async () => {
  const { isHollow } = await import('../plugin/scripts/lib/merge.mjs');
  assert.equal(isHollow({ status: 'unsure', claims_total: 0 }, { mutated: true }), true);
  assert.equal(isHollow({ status: 'unsure', claims_total: 0 }, { mutated: false }), false);
  assert.equal(isHollow({ status: 'unsure', claims_total: 2 }, { mutated: true }), false);
  assert.equal(isHollow({ status: 'verified', claims_total: 0 }, { mutated: true }), false);
});
