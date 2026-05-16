#!/usr/bin/env node

/**
 * evaluate.mjs — Job Fit Evaluator
 *
 * Scores a single job posting against the user's CV and writes a report to
 * reports/{NNN}-{slug}-{YYYY-MM-DD}.md. This is the scriptable form of the
 * `oferta` evaluation mode — it lets the webui (and the background daemon)
 * generate match scores without an interactive AI session.
 *
 * The model is reached through Ollama's chat API (localhost:11434), so it
 * works with both local models and Ollama cloud models
 * (e.g. gemini-3-flash-preview:cloud).
 *
 * Usage:
 *   node evaluate.mjs --url <job-url>     # evaluate one specific job
 *   node evaluate.mjs --next              # evaluate the next unevaluated pipeline job
 *   node evaluate.mjs --model <id>        # override the model
 *
 * Exit codes:
 *   0  success (report written), or nothing-to-do for --next
 *   1  fatal error
 *
 * For --next with an empty queue it prints the literal token
 * NOTHING_TO_EVALUATE so the daemon can fall through to enrichment.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';

// ── Constants ────────────────────────────────────────────────────────────────

const PIPELINE_PATH = 'data/pipeline.md';
const REPORTS_DIR   = 'reports';
const CV_PATH       = 'cv.md';
const SETTINGS_PATH = 'data/settings.json';
const DEFAULT_MODEL = 'gemini-3-flash-preview:cloud';
const OLLAMA_CHAT   = 'http://localhost:11434/api/chat';

// ── CLI args ─────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const NEXT      = args.includes('--next');
const urlIdx    = args.indexOf('--url');
const URL_ARG   = urlIdx !== -1 ? args[urlIdx + 1] : null;
const modelIdx  = args.indexOf('--model');
const MODEL_ARG = modelIdx !== -1 ? args[modelIdx + 1] : null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function loadSettings() {
  if (!existsSync(SETTINGS_PATH)) return {};
  try { return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')); }
  catch { return {}; }
}

/** Parse pipeline.md into [{url, company, title}] */
function parsePipeline() {
  if (!existsSync(PIPELINE_PATH)) return [];
  const text = readFileSync(PIPELINE_PATH, 'utf-8');
  const jobs = [];
  for (const m of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)(?: \| ([^|\n]+))?(?: \| ([^|\n]+))?/g)) {
    jobs.push({
      url:     m[1].trim(),
      company: (m[2] || '').trim() || 'Unknown',
      title:   (m[3] || '').trim() || 'Unknown Role',
    });
  }
  return jobs;
}

/** Set of company slugs that already have a report file */
function evaluatedSlugs() {
  const seen = new Set();
  if (!existsSync(REPORTS_DIR)) return seen;
  for (const f of readdirSync(REPORTS_DIR)) {
    if (!f.endsWith('.md')) continue;
    // {NNN}-{slug}-{date}.md — strip the leading number and trailing date
    const core = f.replace(/^\d+-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/, '');
    if (core) seen.add(core);
  }
  return seen;
}

/** Next sequential 3-digit report number */
function nextReportNumber() {
  let max = 0;
  if (existsSync(REPORTS_DIR)) {
    for (const f of readdirSync(REPORTS_DIR)) {
      const m = f.match(/^(\d+)-/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return String(max + 1).padStart(3, '0');
}

/** Fetch a URL and return readable text (best-effort HTML strip). */
async function fetchJobText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { text: '', note: `HTTP ${res.status}` };
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    return { text: text.slice(0, 8_000), note: text.length < 400 ? 'thin (JS-rendered?)' : 'ok' };
  } catch (err) {
    return { text: '', note: err.message };
  }
}

/** Call the model via Ollama's chat API, forcing JSON output. */
async function callModel(model, prompt) {
  const res = await fetch(OLLAMA_CHAT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    throw new Error(`Ollama returned HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const content = data?.message?.content ?? '';
  try {
    return JSON.parse(content);
  } catch {
    // Some models wrap JSON in prose — extract the first {...} block
    const m = content.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Model did not return valid JSON');
  }
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(cv, job, jdText) {
  return `You are an expert career advisor scoring how well a candidate fits a job.

CANDIDATE CV:
${cv.slice(0, 6_000)}

JOB POSTING:
Company: ${job.company}
Role: ${job.title}
URL: ${job.url}
Description:
${jdText || '(could not fetch full description — score conservatively from the title)'}

Score the fit on a 1.0–5.0 scale where 5.0 is an exceptional match and below
4.0 means the candidate should probably not apply.

Also judge posting legitimacy as one of: legitimate, uncertain, suspicious.

Respond with ONLY a JSON object, no markdown, in exactly this shape:
{
  "score": 4.2,
  "recommendation": "apply" | "maybe" | "skip",
  "legitimacy": "legitimate" | "uncertain" | "suspicious",
  "summary": "2-3 sentence overall assessment",
  "strengths": ["matching strength 1", "strength 2"],
  "gaps": ["gap or risk 1", "gap 2"],
  "comp_notes": "brief note on compensation/seniority fit if inferable, else empty"
}`;
}

// ── Report writer ────────────────────────────────────────────────────────────

function writeReport(job, result, jdNote, model) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const num  = nextReportNumber();
  const slug = slugify(job.company);
  const date = new Date().toISOString().slice(0, 10);
  const path = `${REPORTS_DIR}/${num}-${slug}-${date}.md`;

  const score = Number(result.score);
  const list  = (arr) => (arr && arr.length ? arr.map((x) => `- ${x}`).join('\n') : '- (none noted)');

  const md = `# ${job.company} — ${job.title}

**Score:** ${score.toFixed(1)}/5
**URL:** ${job.url}
**Legitimacy:** ${result.legitimacy || 'uncertain'}
**Recommendation:** ${result.recommendation || 'maybe'}
**Evaluated:** ${date} (auto · model: ${model})
**JD fetch:** ${jdNote}

## A. Summary

${result.summary || '(no summary)'}

## B. Strengths

${list(result.strengths)}

## C. Gaps & Risks

${list(result.gaps)}

## D. Compensation & Seniority

${result.comp_notes || '(not assessed)'}

---
*Generated by evaluate.mjs — review before applying.*
`;
  writeFileSync(path, md, 'utf-8');
  return { path, num, score };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const settings = loadSettings();
  const model = MODEL_ARG || settings.daemonModel || DEFAULT_MODEL;

  // ── Pick the job to evaluate ────────────────────────────────────────────
  let job;
  if (URL_ARG) {
    const fromPipeline = parsePipeline().find((j) => j.url === URL_ARG);
    job = fromPipeline || { url: URL_ARG, company: 'Unknown', title: 'Unknown Role' };
  } else if (NEXT) {
    const done = evaluatedSlugs();
    job = parsePipeline().find((j) => !done.has(slugify(j.company)));
    if (!job) {
      console.log('NOTHING_TO_EVALUATE');
      process.exit(0);
    }
  } else {
    console.error('Usage: node evaluate.mjs --url <url>  |  --next');
    process.exit(1);
  }

  console.log(`Evaluating: ${job.company} — ${job.title}`);
  console.log(`Model:      ${model}`);
  console.log(`URL:        ${job.url}`);

  const cv = existsSync(CV_PATH) ? readFileSync(CV_PATH, 'utf-8') : '';
  if (!cv) console.warn('Warning: cv.md not found — scoring without CV context.');

  const { text: jdText, note: jdNote } = await fetchJobText(job.url);
  console.log(`JD fetch:   ${jdNote} (${jdText.length} chars)`);

  let result;
  try {
    result = await callModel(model, buildPrompt(cv, job, jdText));
  } catch (err) {
    console.error(`Evaluation failed: ${err.message}`);
    process.exit(1);
  }

  if (typeof result.score !== 'number' || isNaN(result.score)) {
    console.error('Model response missing a numeric score.');
    process.exit(1);
  }

  const { path, num, score } = writeReport(job, result, jdNote, model);
  console.log(`\n✓ Report ${num} written: ${path}`);
  console.log(`  Score: ${score.toFixed(1)}/5 · ${result.recommendation || 'maybe'}`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
