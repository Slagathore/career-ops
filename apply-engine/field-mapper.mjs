/**
 * apply-engine/field-mapper.mjs
 *
 * Parses an evaluation report (.md) + config/profile.yml to build a
 * FieldAnswers object that the ATS adapters use to fill form fields.
 *
 * No side effects — pure parsing + file reads. Safe to call multiple times.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

// ── Path helpers ─────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
// apply-engine/ is one level below project root
export const ROOT_DIR = resolve(__dirname, '..');

// ── Profile loader ────────────────────────────────────────────────────────────

/**
 * Load and parse config/profile.yml.
 * @param {string} [overridePath]  Absolute path override (for testing)
 * @returns {object} Parsed YAML profile
 */
export function loadProfile(overridePath) {
  const path = overridePath || join(ROOT_DIR, 'config', 'profile.yml');
  if (!existsSync(path)) {
    throw new Error(
      `Profile not found at ${path}. ` +
      `Copy config/profile.example.yml → config/profile.yml and fill in your details.`
    );
  }
  return yaml.load(readFileSync(path, 'utf-8'));
}

// ── Report parser ─────────────────────────────────────────────────────────────

/**
 * Parse a career-ops evaluation report (.md).
 *
 * Expected format (from modes/oferta.md):
 *   # Evaluación: {Company} — {Role}
 *   **Score:** {X/5}
 *   **URL:** {url}
 *   **Legitimacy:** {tier}
 *   **PDF:** {path}
 *   ## A) ...   ## B) ...   ## H) Draft Application Answers
 *
 * @param {string} reportPath  Absolute path to the report .md
 * @returns {ParsedReport}
 */
export function parseReport(reportPath) {
  if (!existsSync(reportPath)) {
    throw new Error(`Report not found: ${reportPath}`);
  }
  const text = readFileSync(reportPath, 'utf-8');

  // ── Header metadata ──────────────────────────────────────────────────────
  // Title line: "# Evaluación: Company — Role"  or  "# Company — Role"
  const titleMatch = text.match(/^#\s+(?:Evaluaci[oó]n:\s+)?(.+?)(?:\s+[—\-–]+\s+(.+))?$/m);
  const company = titleMatch?.[1]?.trim() ?? null;
  const role     = titleMatch?.[2]?.trim() ?? null;

  const scoreMatch      = text.match(/\*\*Score:\*\*\s*([\d.]+)\s*\/\s*5/i);
  const urlMatch        = text.match(/\*\*URL:\*\*\s*(https?:\/\/\S+)/i);
  const legitimacyMatch = text.match(/\*\*Legitimacy:\*\*\s*(.+)/i);
  const archetypeMatch  = text.match(/\*\*Arquetipo:\*\*\s*(.+)/i);

  // ── Section extractor ────────────────────────────────────────────────────
  // Matches "## A) ...", "## B) ...", "## H) Draft Application Answers", etc.
  // Also catches "## Keywords extraídas" (no letter prefix) as 'K'.
  const sections = {};
  const sectionRe = /^##\s+(([A-H])\)\s*.+|Keywords.+)$/gm;
  let m;
  const sectionStarts = [];

  while ((m = sectionRe.exec(text)) !== null) {
    const key = m[2] ?? 'K';  // fall back to 'K' for keywords block
    sectionStarts.push({ key, start: m.index, headingEnd: m.index + m[0].length });
  }

  for (let i = 0; i < sectionStarts.length; i++) {
    const { key, headingEnd } = sectionStarts[i];
    const nextStart = sectionStarts[i + 1]?.start ?? text.length;
    sections[key] = text.slice(headingEnd, nextStart).trim();
  }

  return {
    company,
    role,
    score:      scoreMatch      ? parseFloat(scoreMatch[1])   : null,
    url:        urlMatch?.[1]   ?? null,
    legitimacy: legitimacyMatch?.[1]?.trim()                  ?? null,
    archetype:  archetypeMatch?.[1]?.trim()                   ?? null,
    sections,   // { A: "...", B: "...", ... H: "...", K: "..." }
    raw: text,
    path: reportPath,
  };
}

// ── Section H parser ──────────────────────────────────────────────────────────

/**
 * Parse Section H "Draft Application Answers" into a keyed object.
 *
 * Expected H format:
 *   ### Why are you interested in this role?
 *   > Answer text here
 *   (possibly multiple paragraphs)
 *
 * Returns object keyed by normalized question label.
 * Special keys: coverLetter, whyThisRole, whyThisCompany, relevantExperience, goodFit, howHeard
 */
export function parseHSection(hText) {
  if (!hText) return {};

  const answers = {};

  // Split on ### headings
  const questionBlocks = hText.split(/^###\s+/m).filter(Boolean);

  for (const block of questionBlocks) {
    const lines = block.split('\n');
    const question = lines[0].trim().replace(/\?$/, '').toLowerCase();
    // Answer text: lines starting with > (blockquote) or plain paragraphs
    const answerLines = lines.slice(1)
      .map(l => l.replace(/^>\s?/, '').trim())
      .filter(Boolean);
    const answer = answerLines.join('\n').trim();

    if (!answer) continue;

    // Normalize to well-known keys
    if (/cover letter/i.test(question)) {
      answers.coverLetter = answer;
    } else if (/why.*(this role|role|position)/i.test(question)) {
      answers.whyThisRole = answer;
    } else if (/why.*(this company|company|want to work)/i.test(question)) {
      answers.whyThisCompany = answer;
    } else if (/relevant (project|achievement|experience)/i.test(question)) {
      answers.relevantExperience = answer;
    } else if (/(good fit|fit for|make you)/i.test(question)) {
      answers.goodFit = answer;
    } else if (/how did you hear/i.test(question)) {
      answers.howHeard = answer;
    } else {
      // Store under the original question text (for fuzzy matching in adapters)
      answers[question] = answer;
    }
  }

  return answers;
}

// ── PDF finder ────────────────────────────────────────────────────────────────

/**
 * Find the best matching PDF for a given company + role.
 *
 * Strategy (in order):
 *   1. `output/{company-slug}-{role-slug}*.pdf`  (most common generate-pdf.mjs pattern)
 *   2. Any PDF in `output/` with both company and role words in the filename
 *   3. Most recently modified PDF in `output/` (last resort)
 *
 * @param {string} company   Company name from report
 * @param {string} role      Role title from report
 * @returns {string|null}    Absolute path to PDF, or null if none found
 */
export function findResumePdf(company, role) {
  const outputDir = join(ROOT_DIR, 'output');
  if (!existsSync(outputDir)) return null;

  let pdfs;
  try {
    pdfs = readdirSync(outputDir)
      .filter(f => f.endsWith('.pdf'))
      .map(f => ({
        name: f,
        path: join(outputDir, f),
        mtime: statSync(join(outputDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime); // newest first
  } catch {
    return null;
  }

  if (pdfs.length === 0) return null;

  // Slugify for comparison
  const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const companySlug = slug(company);
  const roleSlug    = slug(role);

  // Strategy 1: filename starts with both slugs
  const exact = pdfs.find(f =>
    f.name.startsWith(`${companySlug}-${roleSlug}`) ||
    f.name.startsWith(`${companySlug}_${roleSlug}`)
  );
  if (exact) return exact.path;

  // Strategy 2: filename contains both company words AND role words
  const companyWords = companySlug.split('-').filter(w => w.length > 2);
  const roleWords    = roleSlug.split('-').filter(w => w.length > 3);

  const fuzzy = pdfs.find(f => {
    const lower = f.name.toLowerCase();
    const hasCompany = companyWords.length === 0 || companyWords.every(w => lower.includes(w));
    const hasRole    = roleWords.length === 0    || roleWords.some(w => lower.includes(w));
    return hasCompany && hasRole;
  });
  if (fuzzy) return fuzzy.path;

  // Strategy 3: most recently modified PDF
  return pdfs[0]?.path ?? null;
}

// ── Current title/company extraction ─────────────────────────────────────────

/**
 * Extract the candidate's current title from the cv.md (first job header).
 */
export function extractCurrentTitle() {
  const cvPath = join(ROOT_DIR, 'cv.md');
  if (!existsSync(cvPath)) return '';
  const text = readFileSync(cvPath, 'utf-8');
  // Match: "**Senior ML Engineer / ML Platform Lead**" or similar bold line after company name
  const m = text.match(/\*\*([^*\n]+(?:Engineer|Architect|Manager|Lead|Developer|Analyst|Scientist|Consultant|Director|VP|Head)[^*\n]*)\*\*/i);
  return m?.[1]?.trim() ?? '';
}

/**
 * Extract the candidate's current/most recent employer from cv.md.
 */
export function extractCurrentCompany() {
  const cvPath = join(ROOT_DIR, 'cv.md');
  if (!existsSync(cvPath)) return '';
  const text = readFileSync(cvPath, 'utf-8');
  // Match the first "### CompanyName" or "## Work Experience\n\n### CompanyName"
  const workSection = text.match(/## (?:Work Experience|Experience|Employment).*([\s\S]+?)(?=##|$)/i)?.[1] ?? text;
  const m = workSection.match(/###\s+(.+)/);
  return m?.[1]?.trim() ?? '';
}

// ── Auto-locate report ────────────────────────────────────────────────────────

/**
 * Auto-locate a report in data/reports/ (or reports/) by company + role.
 * Returns the path of the most recently created matching report.
 *
 * @param {string} company
 * @param {string} role
 * @returns {string|null}
 */
export function findReport(company, role) {
  // Reports can live in reports/ or data/reports/
  const candidateDirs = [
    join(ROOT_DIR, 'reports'),
    join(ROOT_DIR, 'data', 'reports'),
  ];

  const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12);
  const companySlug = slug(company);
  const roleSlug    = slug(role);

  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .map(f => ({ name: f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      // Match on company (or role) slug — but ONLY when the slug is non-empty.
      // `"anything".includes("")` is always true, so without this guard an
      // empty roleSlug matched every report and returned the newest one,
      // loading the wrong company's data into the application form.
      const match = files.find(f => {
        const lower = f.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        return (companySlug && lower.includes(companySlug)) ||
               (roleSlug && lower.includes(roleSlug));
      });
      if (match) return match.path;
    } catch {
      // ignore unreadable dirs
    }
  }
  return null;
}

// ── Master builder ────────────────────────────────────────────────────────────

/**
 * Build the complete FieldAnswers object from profile.yml + parsed report.
 *
 * @param {object}       profile  Parsed profile.yml
 * @param {ParsedReport} report   Output of parseReport()
 * @returns {FieldAnswers}
 */
export function buildFieldAnswers(profile, report) {
  const c    = profile?.candidate      ?? {};
  const comp = profile?.compensation   ?? {};
  const loc  = profile?.location       ?? {};

  // Parse name
  const fullName  = c.full_name ?? '';
  const spaceIdx  = fullName.indexOf(' ');
  const firstName = spaceIdx > 0 ? fullName.slice(0, spaceIdx) : fullName;
  const lastName  = spaceIdx > 0 ? fullName.slice(spaceIdx + 1) : '';

  // Parse section H for draft answers
  const hText      = report.sections?.['H'] ?? '';
  const hAnswers   = parseHSection(hText);

  // Best cover letter: from H section, else from profile.narrative if it has one
  const coverLetter =
    hAnswers.coverLetter ??
    hAnswers.whyThisRole ??
    null;

  // Why this company: from H section, else lightly from section C (strategy)
  const whyThisCompany =
    hAnswers.whyThisCompany ??
    extractFirstParagraph(report.sections?.['C'] ?? '');

  // Why this role: from H section
  const whyThisRole =
    hAnswers.whyThisRole ??
    null;

  // Work authorization
  let workAuth = loc.visa_status ?? '';
  // Normalize to typical Greenhouse dropdown value
  if (/no sponsor/i.test(workAuth) || /authorized/i.test(workAuth) || /citizen/i.test(workAuth) || /eu citizen/i.test(workAuth)) {
    workAuth = 'Yes, I am authorized to work in this location';
  } else if (/sponsor/i.test(workAuth) || /visa required/i.test(workAuth)) {
    workAuth = 'No, I will require sponsorship';
  }

  // Build all custom answers (H answers minus the ones promoted above)
  const customAnswers = { ...hAnswers };
  delete customAnswers.coverLetter;
  delete customAnswers.whyThisRole;
  delete customAnswers.whyThisCompany;

  // Resume path
  const resumePath = findResumePdf(report.company, report.role);

  return {
    // Contact
    firstName,
    lastName,
    email:     c.email         ?? '',
    phone:     c.phone         ?? '',
    linkedin:  normalizeLinkedIn(c.linkedin  ?? ''),
    github:    normalizeUrl(c.github         ?? ''),
    portfolio: normalizeUrl(c.portfolio_url  ?? ''),

    // Professional context
    currentTitle:   extractCurrentTitle(),
    currentCompany: extractCurrentCompany(),
    yearsExperience: '',  // not reliably derivable without parsing the full CV

    // Application answers
    coverLetter,
    whyThisCompany,
    whyThisRole,
    salaryExpectation: comp.target_range ?? '',
    workAuthorization: workAuth,
    remotePreference:  comp.location_flexibility ?? loc.onsite_availability ?? '',

    // All remaining H-section answers (label → answer string)
    customAnswers,

    // PDF path — absolute, Playwright-compatible
    resumePath,

    // Pass-through for context in adapter
    _report: report,
    _profile: profile,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractFirstParagraph(text) {
  const cleaned = text
    .replace(/\|[^\n]+\|/g, '')       // strip table rows
    .replace(/^#{1,4}\s+.+$/gm, '')   // strip sub-headings
    .trim();
  const match = cleaned.match(/^(.{30,400}?)(?:\n\n|\n#|$)/s);
  return match?.[1]?.replace(/\s+/g, ' ').trim() ?? null;
}

function normalizeLinkedIn(raw) {
  if (!raw) return '';
  if (raw.startsWith('http')) return raw;
  return `https://${raw}`;
}

function normalizeUrl(raw) {
  if (!raw) return '';
  if (raw.startsWith('http')) return raw;
  return `https://${raw}`;
}
