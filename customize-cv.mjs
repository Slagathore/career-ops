#!/usr/bin/env node

/**
 * customize-cv.mjs — Tailored CV Generator
 *
 * Takes cv.md + a job posting, asks the model to tailor the CV to that role,
 * fills templates/cv-template.html, and renders a PDF into output/.
 *
 * The model returns STRUCTURED JSON (not HTML) — this script builds the HTML
 * fragments deterministically from the template's known CSS classes, which is
 * far more reliable than asking a model to emit correct markup.
 *
 * Reached through Ollama's chat API, so it works with local and cloud models
 * (default gemini-3-flash-preview:cloud).
 *
 * Usage:
 *   node customize-cv.mjs --url <job-url>
 *   node customize-cv.mjs --company "OpenAI" --role "Solutions Engineer"
 *   node customize-cv.mjs --url <url> --model <id>
 *
 * Output:
 *   output/cv-{company}-{date}.html   (filled template)
 *   output/cv-{company}-{date}.pdf    (rendered — appears in the Documents panel)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import yaml from 'js-yaml';

// ── Constants ────────────────────────────────────────────────────────────────

const CV_PATH       = 'cv.md';
const PROFILE_PATH  = 'config/profile.yml';
const TEMPLATE_PATH = 'templates/cv-template.html';
const SETTINGS_PATH = 'data/settings.json';
const OUTPUT_DIR    = 'output';
const DEFAULT_MODEL = 'gemini-3-flash-preview:cloud';
const OLLAMA_CHAT   = 'http://localhost:11434/api/chat';

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const arg  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const URL_ARG     = arg('--url');
const COMPANY_ARG = arg('--company');
const ROLE_ARG    = arg('--role');
const MODEL_ARG   = arg('--model');

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Escape text for safe insertion into HTML. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loadSettings() {
  if (!existsSync(SETTINGS_PATH)) return {};
  try { return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')); }
  catch { return {}; }
}

/** Fetch a URL and return readable text (best-effort HTML strip). */
async function fetchJobText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return '';
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim().slice(0, 8_000);
  } catch {
    return '';
  }
}

/** Call the model via Ollama, forcing JSON output. */
async function callModel(model, prompt) {
  const res = await fetch(OLLAMA_CHAT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, stream: false, format: 'json',
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  const content = (await res.json())?.message?.content ?? '';
  try {
    return JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Model did not return valid JSON');
  }
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(cv, company, role, jdText) {
  return `You are an expert resume writer. Tailor the candidate's CV to the
target job below. Keep every claim truthful — only re-emphasize, reorder, and
rephrase what is already in the CV. Do NOT invent experience.

CANDIDATE CV (markdown):
${cv}

TARGET JOB:
Company: ${company}
Role: ${role}
Description:
${jdText || '(no description available — tailor from the role title)'}

Return ONLY a JSON object in exactly this shape (no markdown, no commentary):
{
  "summary": "tailored 3-4 sentence professional summary aimed at this role",
  "competencies": ["short tag", "short tag", "..."],
  "experience": [
    {
      "company": "Employer",
      "role": "Job Title",
      "location": "City, ST or Remote",
      "period": "Mon YYYY – Mon YYYY",
      "bullets": ["achievement bullet tailored to the target role", "..."]
    }
  ],
  "projects": [
    { "title": "Project", "badge": "short label or empty", "tech": "tech used", "desc": "1-2 sentence description" }
  ],
  "education": [
    { "title": "Degree", "org": "Institution", "year": "YYYY", "desc": "optional detail or empty" }
  ],
  "certifications": [
    { "title": "Certification", "org": "Issuer", "year": "YYYY" }
  ],
  "skills": [
    { "category": "Category name", "items": "comma, separated, skills" }
  ]
}
Preserve all real roles from the CV. Order experience newest-first.`;
}

// ── HTML fragment builders ───────────────────────────────────────────────────

function buildExperience(items) {
  return (items || []).map((j) => `
  <div class="job">
    <div class="job-header">
      <span class="job-company">${esc(j.company)}</span>
      <span class="job-period">${esc(j.period)}</span>
    </div>
    <div class="job-role">${esc(j.role)}</div>
    <div class="job-location">${esc(j.location)}</div>
    <ul>
      ${(j.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('\n      ')}
    </ul>
  </div>`).join('\n');
}

function buildCompetencies(items) {
  return (items || [])
    .map((c) => `<span class="competency-tag">${esc(c)}</span>`)
    .join('\n      ');
}

function buildProjects(items) {
  return (items || []).map((p) => `
  <div class="project">
    <span class="project-title">${esc(p.title)}</span>${
      p.badge ? `<span class="project-badge">${esc(p.badge)}</span>` : ''}
    <div class="project-desc">${esc(p.desc)}</div>
    ${p.tech ? `<div class="project-tech">${esc(p.tech)}</div>` : ''}
  </div>`).join('\n');
}

function buildEducation(items) {
  return (items || []).map((e) => `
  <div class="edu-item">
    <div class="edu-header">
      <span><span class="edu-title">${esc(e.title)}</span> · <span class="edu-org">${esc(e.org)}</span></span>
      <span class="edu-year">${esc(e.year)}</span>
    </div>
    ${e.desc ? `<div class="edu-desc">${esc(e.desc)}</div>` : ''}
  </div>`).join('\n');
}

function buildCertifications(items) {
  return (items || []).map((c) => `
  <div class="cert-item">
    <span><span class="cert-title">${esc(c.title)}</span> · <span class="cert-org">${esc(c.org)}</span></span>
    <span class="cert-year">${esc(c.year)}</span>
  </div>`).join('\n');
}

function buildSkills(items) {
  return `<div class="skills-grid">
    ${(items || []).map((s) =>
      `<div class="skill-item"><span class="skill-category">${esc(s.category)}:</span> ${esc(s.items)}</div>`
    ).join('\n    ')}
  </div>`;
}

// ── Template filler ──────────────────────────────────────────────────────────

function fillTemplate(template, cand, tailored) {
  const linkedin  = (cand.linkedin || '').replace(/^https?:\/\//, '');
  const portfolio = (cand.portfolio_url || cand.portfolio || '').replace(/^https?:\/\//, '');
  const map = {
    LANG:                  'en',
    PAGE_WIDTH:            '8.5in',
    NAME:                  esc(cand.full_name || 'Candidate'),
    PHONE:                 esc(cand.phone || ''),
    EMAIL:                 esc(cand.email || ''),
    LINKEDIN_URL:          linkedin ? 'https://' + linkedin : '',
    LINKEDIN_DISPLAY:      esc(linkedin),
    PORTFOLIO_URL:         portfolio ? 'https://' + portfolio : '',
    PORTFOLIO_DISPLAY:     esc(portfolio),
    LOCATION:              esc(cand.location || ''),
    SECTION_SUMMARY:       'Professional Summary',
    SECTION_COMPETENCIES:  'Core Competencies',
    SECTION_EXPERIENCE:    'Professional Experience',
    SECTION_PROJECTS:      'Projects',
    SECTION_EDUCATION:     'Education',
    SECTION_CERTIFICATIONS:'Certifications',
    SECTION_SKILLS:        'Skills',
    SUMMARY_TEXT:          esc(tailored.summary || ''),
    COMPETENCIES:          buildCompetencies(tailored.competencies),
    EXPERIENCE:            buildExperience(tailored.experience),
    PROJECTS:              buildProjects(tailored.projects),
    EDUCATION:             buildEducation(tailored.education),
    CERTIFICATIONS:        buildCertifications(tailored.certifications),
    SKILLS:                buildSkills(tailored.skills),
  };
  let out = template;
  for (const [key, val] of Object.entries(map)) {
    out = out.replaceAll(`{{${key}}}`, val);
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(CV_PATH))       { console.error('Error: cv.md not found.'); process.exit(1); }
  if (!existsSync(TEMPLATE_PATH)) { console.error(`Error: ${TEMPLATE_PATH} not found.`); process.exit(1); }

  const model = MODEL_ARG || loadSettings().daemonModel || DEFAULT_MODEL;
  const cv = readFileSync(CV_PATH, 'utf-8');

  let cand = {};
  if (existsSync(PROFILE_PATH)) {
    try { cand = (yaml.load(readFileSync(PROFILE_PATH, 'utf-8'))?.candidate) || {}; }
    catch { /* fall through with empty candidate */ }
  }

  // ── Resolve the target job ──────────────────────────────────────────────
  let company = COMPANY_ARG || 'Target Company';
  let role    = ROLE_ARG || 'Target Role';
  let jdText  = '';
  if (URL_ARG) {
    jdText = await fetchJobText(URL_ARG);
    if (!COMPANY_ARG) {
      // Best-effort company from the URL host/path.
      const m = URL_ARG.match(/(?:ashbyhq\.com|lever\.co|greenhouse\.io)\/([^/?]+)/i);
      if (m) company = m[1].replace(/-/g, ' ');
    }
  }
  console.log(`Tailoring CV → ${company} / ${role}`);
  console.log(`Model: ${model}`);

  // ── Tailor via the model ────────────────────────────────────────────────
  let tailored;
  try {
    tailored = await callModel(model, buildPrompt(cv, company, role, jdText));
  } catch (err) {
    console.error(`Tailoring failed: ${err.message}`);
    process.exit(1);
  }
  if (!tailored.summary || !Array.isArray(tailored.experience)) {
    console.error('Model response missing required fields (summary / experience).');
    process.exit(1);
  }

  // ── Fill template + write HTML ──────────────────────────────────────────
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const template = readFileSync(TEMPLATE_PATH, 'utf-8');
  const html     = fillTemplate(template, cand, tailored);

  const slug     = slugify(company) || 'job';
  const date     = new Date().toISOString().slice(0, 10);
  const htmlPath = `${OUTPUT_DIR}/cv-${slug}-${date}.html`;
  const pdfPath  = `${OUTPUT_DIR}/cv-${slug}-${date}.pdf`;
  writeFileSync(htmlPath, html, 'utf-8');
  console.log(`✓ HTML written: ${htmlPath}`);

  // ── Render PDF via generate-pdf.mjs ─────────────────────────────────────
  const r = spawnSync('node', ['generate-pdf.mjs', htmlPath, pdfPath, '--format=letter'],
    { stdio: 'inherit' });
  if (r.status === 0 && existsSync(pdfPath)) {
    console.log(`\n✓ Tailored CV ready: ${pdfPath}`);
  } else {
    console.error(`\n⚠️  PDF render failed — the HTML is still available at ${htmlPath}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
