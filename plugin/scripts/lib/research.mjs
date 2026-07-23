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
// Secret-shaped: one unbroken run of 20+ non-space chars (API keys, tokens,
// hashes, paths). Real research topics are short natural-language keywords.
const SECRET_TOKEN_RE = /\S{20,}/;

export function sanitizeTopics(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.length <= MAX_TOPIC_CHARS && !SECRET_TOKEN_RE.test(t))
    .slice(0, MAX_TOPICS);
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
  const topics = sanitizeTopics(verdict.external_claims);
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
