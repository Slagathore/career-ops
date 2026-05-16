/**
 * apply-engine/dry-run-report.mjs
 *
 * Produces a human-readable dry-run summary saved to:
 *   data/dry-runs/{company-slug}-{timestamp}.md
 *
 * Called after a dry-run session completes with a FilledForm result.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = resolve(__dirname, '..');
const DRY_RUN_DIR = join(ROOT_DIR, 'data', 'dry-runs');

/**
 * @typedef {object} FieldRecord
 * @property {string} label     Human-readable field label
 * @property {string} value     The value that was (or would be) filled
 * @property {string} [selector] CSS selector used
 */

/**
 * @typedef {object} FilledForm
 * @property {FieldRecord[]} filled    Fields successfully filled
 * @property {string[]}      skipped   Field labels that were skipped (no data or not found)
 * @property {string[]}      warnings  Non-fatal issues
 * @property {string|null}   screenshotPath  Absolute path to saved screenshot
 * @property {string}        ats       ATS type (e.g. 'greenhouse')
 * @property {string}        jobUrl    The URL navigated to
 * @property {string}        company   Company name
 * @property {string}        role      Role title
 */

/**
 * Write a dry-run report and return its path.
 *
 * @param {FilledForm} result
 * @param {object}     fieldAnswers   FieldAnswers from field-mapper
 * @param {boolean}    [dryRun=true]  True = dry run, false = live submission
 * @returns {string}   Absolute path to the written report
 */
export function writeDryRunReport(result, fieldAnswers, dryRun = true) {
  mkdirSync(DRY_RUN_DIR, { recursive: true });

  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const companySlug = slugify(result.company || 'unknown');
  const filename    = `${companySlug}-${timestamp}.md`;
  const reportPath  = join(DRY_RUN_DIR, filename);

  const md = buildMarkdown(result, fieldAnswers, dryRun, timestamp);
  writeFileSync(reportPath, md, 'utf-8');

  return reportPath;
}

// ── Markdown builder ──────────────────────────────────────────────────────────

function buildMarkdown(result, fieldAnswers, dryRun, timestamp) {
  const {
    filled   = [],
    skipped  = [],
    warnings = [],
    screenshotPath,
    ats,
    jobUrl,
    company,
    role,
  } = result;

  const date = timestamp.slice(0, 10);
  const mode = dryRun ? '🔒 Dry Run' : '🚀 Live Submission';

  const lines = [
    `# ${dryRun ? 'Dry Run' : 'Submission'}: ${company || 'Unknown Company'} — ${role || 'Unknown Role'}`,
    '',
    `**Date:** ${date}`,
    `**Mode:** ${mode}`,
    `**ATS:** ${ats || 'unknown'}`,
    `**Job URL:** ${jobUrl || 'n/a'}`,
    '',
    '---',
    '',
  ];

  // ── Fields filled ──────────────────────────────────────────────────────
  lines.push(`## Fields Filled (${filled.length})`);
  lines.push('');
  if (filled.length > 0) {
    lines.push('| Field | Value |');
    lines.push('|-------|-------|');
    for (const f of filled) {
      const val = truncate(f.value ?? '', 80);
      const escaped = val.replace(/\|/g, '\\|');
      lines.push(`| ${f.label} | ${escaped} |`);
    }
  } else {
    lines.push('_No fields were filled._');
  }
  lines.push('');

  // ── Fields skipped ─────────────────────────────────────────────────────
  lines.push(`## Fields Skipped (${skipped.length})`);
  lines.push('');
  if (skipped.length > 0) {
    for (const s of skipped) {
      lines.push(`- ${s}`);
    }
  } else {
    lines.push('_None._');
  }
  lines.push('');

  // ── Warnings ────────────────────────────────────────────────────────────
  lines.push(`## Warnings (${warnings.length})`);
  lines.push('');
  if (warnings.length > 0) {
    for (const w of warnings) {
      lines.push(`- ${w}`);
    }
  } else {
    lines.push('_None._');
  }
  lines.push('');

  // ── PDF resume ─────────────────────────────────────────────────────────
  lines.push('## PDF Resume');
  lines.push('');
  if (fieldAnswers?.resumePath) {
    lines.push(`Uploaded: \`${fieldAnswers.resumePath}\``);
  } else {
    lines.push('⚠️  No resume PDF found — upload was skipped.');
  }
  lines.push('');

  // ── Screenshot ─────────────────────────────────────────────────────────
  lines.push('## Screenshot');
  lines.push('');
  if (screenshotPath) {
    lines.push(`\`${screenshotPath}\``);
  } else {
    lines.push('_No screenshot taken._');
  }
  lines.push('');

  // ── Answers used ──────────────────────────────────────────────────────
  if (fieldAnswers?.coverLetter || fieldAnswers?.whyThisCompany || fieldAnswers?.whyThisRole) {
    lines.push('## Draft Answers Used');
    lines.push('');
    if (fieldAnswers.whyThisRole) {
      lines.push('### Why This Role');
      lines.push('');
      lines.push(truncate(fieldAnswers.whyThisRole, 400));
      lines.push('');
    }
    if (fieldAnswers.whyThisCompany) {
      lines.push('### Why This Company');
      lines.push('');
      lines.push(truncate(fieldAnswers.whyThisCompany, 400));
      lines.push('');
    }
    if (fieldAnswers.coverLetter) {
      lines.push('### Cover Letter');
      lines.push('');
      lines.push(truncate(fieldAnswers.coverLetter, 600));
      lines.push('');
    }
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  if (dryRun) {
    lines.push('> **DRY RUN COMPLETE** — no form was submitted.');
    lines.push('> Run with `--submit` to actually submit after reviewing the above.');
  } else {
    lines.push('> **LIVE SUBMISSION** — form was submitted.');
  }
  lines.push('');

  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
