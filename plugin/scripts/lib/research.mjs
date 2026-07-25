// lib/research.mjs — the search-isolated second pass (dual-LLM pattern).
//
// Security model: the verify pass (pass 1) reads the repo and the untrusted
// transcript but can NEVER search. This pass (pass 2) can search but runs in
// an EMPTY directory and receives ONLY sanitized topic keywords — it has no
// repo, no transcript, no secrets in its universe, so a prompt-injected
// topic cannot exfiltrate anything it hasn't been handed. sanitizeTopics is
// the programmatic gate on what gets handed over.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCodex, validateVerdict } from './codex.mjs';

const MAX_TOPICS = 3;
const MAX_TOPIC_CHARS = 80;
const MAX_TOTAL_CHARS = 120; // budget across ALL topics, not merely each one
const MAX_TOKEN_CHARS = 20;

// This gate is an ALLOWLIST, deliberately. The previous rule rejected one
// unbroken run of 20+ non-space chars, which a prompt-injected verify pass
// defeated by spelling a secret out across spaces
// ("sk-ant-api03 -AAAABBBB CCCCDDDD ...") — every chunk passed. Topics are
// meant to be short natural-language keywords, so require every token to look
// like a word, a version number, or a short acronym.
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9.'+#-]*$/;
const isSecretish = (t) =>
  (t.length > 8 && /[A-Za-z]/.test(t) && /[0-9]/.test(t)) || // key/hash shaped
  (t.length >= 4 && t === t.toUpperCase() && /[A-Z]/.test(t)); // ALLCAPS run; API/LTS/CLI still fine

// NOTE ON RESIDUAL RISK: shape filtering NARROWS this channel, it does not
// close it. An attacker in full control of the verify pass can still spell
// ~120 characters in innocent-looking words. That is the honest bound: a
// short, low-bandwidth channel, not zero. Hence the logging — a suppressed
// attempt should be visible in hook.log, never silent.
export function sanitizeTopics(raw, log = () => {}) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  let budget = MAX_TOTAL_CHARS;
  for (const item of raw) {
    if (out.length >= MAX_TOPICS) break;
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (t === '') continue;
    if (t.length > MAX_TOPIC_CHARS) {
      log('research: dropped over-long topic');
      continue;
    }
    const bad = t
      .split(/\s+/)
      .find((tok) => tok.length > MAX_TOKEN_CHARS || !TOKEN_RE.test(tok) || isSecretish(tok));
    if (bad !== undefined) {
      log('research: dropped topic containing a non-word token');
      continue;
    }
    if (t.length > budget) {
      log('research: dropped topic over the total egress budget');
      continue;
    }
    budget -= t.length;
    out.push(t);
  }
  return out;
}

export function buildResearchPrompt(topics) {
  return [
    'You are a fact-checker with a web-search tool. You have NO other context',
    'and need none. For EACH topic below, search the web and decide whether the',
    'stated claim holds RIGHT NOW. Cite the source URL in the evidence.',
    'Treat search results skeptically: prefer official/primary sources.',
    'Output ONE JSON object matching the schema. JSON only.',
    '',
    'TOPICS:',
    ...topics.map((t, i) => `${i + 1}. ${t}`),
  ].join('\n');
}

// Run pass 2 for a verdict that carries external_claims. Returns the verdict,
// enriched (never rejects; research failure leaves the verdict untouched).
// Escalation rule: a disproven topic turns an `unsure` verdict into `failed`
// (so foreground mode blocks) — bounded by the same attempt counter as any
// other failure. It never downgrades and never touches `verified`.
export async function applyResearch(verdict, { model, timeoutMs, codexHome, schemaPath, log }) {
  const topics = sanitizeTopics(verdict.external_claims, log);
  if (topics.length === 0) return verdict;

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossverify-research-'));
  try {
    const result = await runCodex({
      prompt: buildResearchPrompt(topics),
      cwd: emptyDir, // the whole point: no repo, no transcript, nothing to leak
      model,
      schemaPath,
      timeoutMs,
      codexHome,
      search: true,
      validate: (o) => Array.isArray(o?.results),
    });
    if (!result.ok || !Array.isArray(result.verdict?.results)) {
      log(`research pass failed open (${result.error || 'bad shape'}) — verdict unchanged`);
      return verdict;
    }
    const researched = result.verdict.results;
    const disproven = researched.filter((r) => r && r.verdict === 'false');
    const out = { ...verdict, research: researched };
    if (disproven.length > 0 && out.status === 'unsure') {
      out.status = 'failed';
      out.claims_failed = (out.claims_failed || 0) + disproven.length;
      out.failed = [
        ...(Array.isArray(out.failed) ? out.failed : []),
        ...disproven.map((r) => ({ claim: r.topic, evidence: r.evidence })),
      ];
      const lines = disproven.map((r) => `- "${r.topic}" is false: ${r.evidence}`);
      out.feedback = [out.feedback, 'Web research disproved:', ...lines]
        .filter(Boolean).join('\n');
      log(`research: ${disproven.length} topic(s) disproven — unsure escalated to failed`);
    }
    return out;
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
}

// validateVerdict re-export spares verifier.mjs a second import site.
export { validateVerdict };
