// lib/merge.mjs — combine the primary verdict with the SECOND reviewer's, and
// sanitize gap-analysis findings.
//
// Second reviewer = the same read-only codex run, but through a different
// model provider (FireRouter on Fireworks by default), so the two verdicts come
// from different vendors. Merge policy, in priority order:
//   1. The primary decides. The second never downgrades a `failed` primary and
//      never, by itself, turns a `verified` primary into a block.
//   2. unsure + second found concrete failures  -> failed (escalate; bounded
//      by the normal attempt counter like the research pass).
//   3. verified + second found concrete failures -> unsure, recorded as a
//      disagreement in needs_from_user. Humans arbitrate, not the hook.
//   4. Gaps from both reviewers are unioned (de-duplicated by text).
// A second-reviewer infrastructure failure is recorded and leaves the verdict
// untouched (fail-open, same as everything else here).

const MAX_GAPS = 10;
const MAX_GAP_TEXT = 300;
const GAP_CLASSES = new Set(['CONFIRMED', 'OPEN_QUESTION']);

const cap = (s, n = MAX_GAP_TEXT) => (typeof s === 'string' ? s.slice(0, n) : '');

// Gap findings are untrusted verifier output derived from repo content: shape-
// check every entry, require evidence (the gaps skill's contract: a finding
// without a file/line or a named missing check is not a finding), cap counts
// and lengths so a report can never flood the builder's context.
export function sanitizeGaps(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_GAPS) break;
    if (!item || typeof item !== 'object') continue;
    const gap = cap(item.gap).trim();
    const evidence = cap(item.evidence).trim();
    if (gap === '' || evidence === '') continue;
    if (!GAP_CLASSES.has(item.classification)) continue;
    out.push({ gap, classification: item.classification, evidence, fix: cap(item.fix).trim() });
  }
  return out;
}

const failedList = (v) => (Array.isArray(v?.failed) ? v.failed.filter((f) => f && typeof f.claim === 'string') : []);

export function mergeVerdicts(primary, second, { model, error } = {}) {
  const out = { ...primary, gaps: sanitizeGaps(primary.gaps) };
  if (!second) {
    out.second = { model, status: 'error', error: error || 'no verdict' };
    return out;
  }
  const secondFailed = failedList(second);
  const concrete = second.status === 'failed' && secondFailed.length > 0;
  const agreed = second.status === primary.status || (!concrete && primary.status !== 'failed');

  out.second = {
    model,
    status: second.status,
    confidence: second.confidence,
    claims_total: second.claims_total,
    claims_failed: second.claims_failed,
    failed: secondFailed,
    could_not_verify: Array.isArray(second.could_not_verify) ? second.could_not_verify : [],
    feedback: typeof second.feedback === 'string' ? second.feedback : '',
    agreed,
  };

  // Union gaps, de-duplicated by the gap text (case-insensitive).
  const seen = new Set(out.gaps.map((g) => g.gap.toLowerCase()));
  for (const g of sanitizeGaps(second.gaps)) {
    if (seen.has(g.gap.toLowerCase())) continue;
    seen.add(g.gap.toLowerCase());
    if (out.gaps.length < MAX_GAPS) out.gaps.push(g);
  }

  if (!concrete || primary.status === 'failed') return out;

  if (primary.status === 'unsure') {
    out.status = 'failed';
    out.confidence = 'FEEDBACK';
    out.claims_failed = (out.claims_failed || 0) + secondFailed.length;
    out.failed = [...failedList(primary), ...secondFailed];
    out.feedback = [out.feedback, `Second reviewer (${model}) found:`, out.second.feedback]
      .filter(Boolean).join('\n');
    return out;
  }

  // primary verified, second failed: disagreement, escalate to the human.
  out.status = 'unsure';
  out.confidence = 'PARTIAL';
  out.feedback = '';
  const lines = secondFailed.map((f) => `- ${cap(f.claim, 200)}${f.evidence ? `: ${cap(f.evidence, 300)}` : ''}`);
  out.needs_from_user = [
    out.needs_from_user,
    `Reviewers disagree: primary verified the turn but the second reviewer (${model}) failed ${secondFailed.length} claim(s):`,
    ...lines,
  ].filter(Boolean).join('\n');
  return out;
}

// One-line, capped summary of a runCodex error string. Codex stderr tails
// carry the prompt echo; the useful part is the last "ERROR: ..." line.
export function summarizeError(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return 'unknown error';
  const [head, ...rest] = raw.split(' | stderr: ');
  const tail = rest.join(' | stderr: ');
  const errLines = tail.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^ERROR:/i.test(l));
  const detail = errLines.length ? errLines[errLines.length - 1].replace(/^ERROR:\s*/i, '') : '';
  const out = detail ? `${head.trim()}: ${detail}` : head.trim();
  return out.replace(/\s+/g, ' ').slice(0, 300);
}

// A verdict that is `unsure` with zero claims on a turn that had mutations
// means the reviewer inspected nothing (no tool calls, placeholder JSON).
// It satisfies the schema but carries no information; flag it so it is never
// mistaken for a real "could not verify".
export function isHollow(verdict, { mutated }) {
  return mutated === true && verdict?.status === 'unsure' && (verdict.claims_total === 0 || verdict.claims_total === undefined);
}
