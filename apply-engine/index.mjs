#!/usr/bin/env node

/**
 * apply-engine/index.mjs — Application Automation Orchestrator
 *
 * CLI entry point for automated form filling via Playwright.
 *
 * Usage:
 *   node apply-engine/index.mjs --url <job-url> [options]
 *
 * Options:
 *   --url <url>           Job posting URL (required)
 *   --report <path>       Path to evaluation report .md (auto-located if omitted)
 *   --ats <type>          Force ATS type: greenhouse | ashby | lever | workday | linkedin
 *   --dry-run             Fill form but don't submit (DEFAULT — always on unless --submit)
 *   --submit              Disable dry-run; prompt for human confirmation before submitting
 *   --headless            Run browser headlessly (default: headed so you can watch)
 *   --profile <path>      Path to profile.yml (default: config/profile.yml)
 *
 * Examples:
 *   node apply-engine/index.mjs --url https://boards.greenhouse.io/anthropic/jobs/12345
 *   node apply-engine/index.mjs --url https://boards.greenhouse.io/stripe/jobs/67890 --submit
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { spawnSync } from 'child_process';
import { chromium } from 'playwright';
import { URL as NodeURL } from 'url';

// ── New: Universal adapter + login system ────────────────────────────────────
import { fillUniversalForm, submitUniversalForm, detectOAuthOptions } from './adapters/universal.mjs';
import { loginToPortal, isLoginWall } from './lib/account-creator.mjs';
import { loadUniversalProfile } from './adapters/universal.mjs';

/** Get per-domain persistent browser profile directory */
function getProfileDir(targetUrl) {
  try {
    const host = new NodeURL(targetUrl).hostname.replace(/\./g, '_');
    return join(ROOT_DIR, 'data', 'browser-profiles', host);
  } catch {
    return join(ROOT_DIR, 'data', 'browser-profiles', 'default');
  }
}

import {
  loadProfile,
  parseReport,
  buildFieldAnswers,
  findReport,
  ROOT_DIR,
} from './field-mapper.mjs';

import {
  fillGreenhouseForm,
  submitGreenhouseForm,
  isGreenhousePage,
} from './adapters/greenhouse.mjs';

import {
  fillForm as fillAshbyForm,
  submitForm as submitAshbyForm,
} from './adapters/ashby.mjs';

import {
  fillForm as fillLeverForm,
  submitForm as submitLeverForm,
} from './adapters/lever.mjs';

import {
  fillForm   as fillWorkdayForm,
  submitForm as submitWorkdayForm,
  isWorkdayPage,
} from './adapters/workday.mjs';

import { fillLinkedInForm, submitLinkedInForm, detectEasyApply } from './adapters/linkedin.mjs';

import { writeDryRunReport } from './dry-run-report.mjs';

// ── Path constants ────────────────────────────────────────────────────────────

const SCREENSHOTS_DIR = join(ROOT_DIR, 'data', 'screenshots');
const DRY_RUNS_DIR    = join(ROOT_DIR, 'data', 'dry-runs');
const APPLICATIONS_MD = join(ROOT_DIR, 'data', 'applications.md');

// ── ATS detection ─────────────────────────────────────────────────────────────

/**
 * Auto-detect the ATS type from a job URL.
 * Mirrors the detectApi() logic in scan.mjs but for posting URLs (not API URLs).
 *
 * @param {string} url
 * @returns {'greenhouse'|'ashby'|'lever'|'workday'|'linkedin'|null}
 */
function detectAts(url) {
  if (!url) return null;
  const lower = url.toLowerCase();

  if (
    lower.includes('boards.greenhouse.io') ||
    lower.includes('job-boards.greenhouse.io') ||
    lower.includes('job-boards.eu.greenhouse.io') ||
    lower.includes('greenhouse.io/jobs')
  ) return 'greenhouse';

  if (
    lower.includes('jobs.ashbyhq.com') ||
    lower.includes('ashbyhq.com')
  ) return 'ashby';

  if (lower.includes('jobs.lever.co')) return 'lever';

  if (
    lower.includes('myworkdayjobs.com') ||
    lower.includes('wd1.myworkdayjobs.com') ||
    lower.includes('wd3.myworkdayjobs.com') ||
    lower.includes('wd5.myworkdayjobs.com')
  ) return 'workday';

  if (
    lower.includes('linkedin.com/jobs') ||
    lower.includes('linkedin.com/company')
  ) return 'linkedin';

  return null;
}

/**
 * Extract company + role guess from a job URL (best-effort, for auto-locating reports).
 * Returns { company, role } — strings may be empty.
 */
function extractCompanyRoleFromUrl(url) {
  try {
    const u = new URL(url);

    // boards.greenhouse.io/{company}/jobs/{id}
    const ghMatch = u.pathname.match(/^\/([^/]+)\/jobs\//);
    if (ghMatch) return { company: ghMatch[1].replace(/-/g, ' '), role: '' };

    // jobs.ashbyhq.com/{company}
    const ashbyMatch = u.hostname.match(/jobs\.ashbyhq\.com/);
    if (ashbyMatch) {
      const parts = u.pathname.split('/').filter(Boolean);
      return { company: parts[0]?.replace(/-/g, ' ') ?? '', role: '' };
    }

    // jobs.lever.co/{company}/{id}
    const leverMatch = u.hostname.match(/jobs\.lever\.co/);
    if (leverMatch) {
      const parts = u.pathname.split('/').filter(Boolean);
      return { company: parts[0]?.replace(/-/g, ' ') ?? '', role: '' };
    }

    return { company: u.hostname.replace(/^(www\.|jobs\.)/, ''), role: '' };
  } catch {
    return { company: '', role: '' };
  }
}

// ── CLI argument parser ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    url:       null,
    reportPath: null,
    ats:       null,
    dryRun:    true,    // default ON
    headless:  false,   // default: headed
    profilePath: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':     opts.url = args[++i]; break;
      case '--report':  opts.reportPath = resolve(args[++i]); break;
      case '--ats':     opts.ats = args[++i]; break;
      case '--profile': opts.profilePath = resolve(args[++i]); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--submit':  opts.dryRun = false; break;
      case '--headless': opts.headless = true; break;
      default:
        if (args[i].startsWith('--')) {
          console.warn(`Unknown option: ${args[i]}`);
        }
    }
  }
  return opts;
}

// ── Human confirmation prompt ─────────────────────────────────────────────────

function askConfirmation(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ── Screenshot helper ─────────────────────────────────────────────────────────

async function takeScreenshot(page, company, role) {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const slug = (s) => (s || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
  const timestamp = new Date().toISOString().slice(0, 10);
  const filename  = `${slug(company)}-${slug(role)}-${timestamp}.png`;
  const path      = join(SCREENSHOTS_DIR, filename);

  try {
    await page.screenshot({ path, fullPage: true });
    return path;
  } catch (err) {
    console.warn(`Screenshot failed: ${err.message}`);
    return null;
  }
}

// ── applications.md updater ───────────────────────────────────────────────────

/**
 * After a successful live submission, update (or add) the row in applications.md.
 * Changes Status from "Evaluated" → "Applied".
 *
 * This respects the DATA CONTRACT: we're updating an EXISTING entry, not adding
 * a new one blindly (per AGENTS.md rule: NEVER create duplicate entries).
 *
 * @param {string} company
 * @param {string} role
 * @param {string} [confirmationUrl]
 */
function updateApplicationsTracker(company, role, confirmationUrl) {
  if (!existsSync(APPLICATIONS_MD)) {
    console.warn(`applications.md not found at ${APPLICATIONS_MD} — skipping tracker update`);
    return;
  }

  let text = readFileSync(APPLICATIONS_MD, 'utf-8');
  const companyLower = company.toLowerCase();
  const roleLower    = role.toLowerCase();

  // Find and update the matching row
  const lines = text.split('\n');
  let updated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match rows that have both company and role somewhere in the line
    if (
      line.includes('|') &&
      line.toLowerCase().includes(companyLower) &&
      line.toLowerCase().includes(roleLower)
    ) {
      // Replace "Evaluated" / "Evaluada" with "Applied"
      const newLine = line
        .replace(/\bEvaluated\b/gi, 'Applied')
        .replace(/\bEvaluada\b/gi, 'Applied')
        .replace(/\bEvaluado\b/gi, 'Applied');

      if (newLine !== line) {
        lines[i] = newLine;
        updated = true;
        console.log(`[LIVE] Tracker updated — ${company} / ${role}: status set to Applied`);
      }
      break;
    }
  }

  if (!updated) {
    console.warn(
      `Could not find matching row in applications.md for ${company} / ${role}. ` +
      `Update the tracker manually or run node merge-tracker.mjs.`
    );
  }

  writeFileSync(APPLICATIONS_MD, lines.join('\n'), 'utf-8');

  if (confirmationUrl) {
    console.log(`[LIVE] Confirmation URL: ${confirmationUrl}`);
  }
}

// ── Adapter dispatcher ────────────────────────────────────────────────────────

/**
 * Dispatch to the correct ATS adapter.
 * Returns the FilledForm result.
 */
async function dispatchAdapter(atsType, page, fieldAnswers, { dryRun, log, company, role }) {
  switch (atsType) {
    case 'greenhouse':
      return fillGreenhouseForm(page, fieldAnswers, { dryRun, log, company, role });

    case 'ashby':
      return fillAshbyForm(page, fieldAnswers, { dryRun, log, company, role });

    case 'lever':
      return fillLeverForm(page, fieldAnswers, { dryRun, log, company, role });

    case 'workday':
      // Workday MUST run headed — headless Chromium is blocked by Workday's bot detection.
      // index.mjs defaults to headed (headless: false), so this is safe unless --headless
      // was explicitly passed. There's no way to warn from here without threading opts
      // through dispatchAdapter, so the warning lives in fillForm() itself.
      return fillWorkdayForm(page, fieldAnswers, { dryRun, log, company, role });

    case 'linkedin':
      return fillLinkedInForm(page, fieldAnswers, { dryRun, log, company, role });

    default: {
      // Unknown ATS — probe the page with each adapter's detector before giving up
      log(`[WARN] Unknown ATS "${atsType}" — probing page for known ATS markers...`);

      const isGH = await isGreenhousePage(page);
      if (isGH) {
        log(`[INFO] Greenhouse form detected via page inspection. Proceeding.`);
        return fillGreenhouseForm(page, fieldAnswers, { dryRun, log, company, role });
      }

      const isWD = await isWorkdayPage(page);
      if (isWD) {
        log(`[INFO] Workday form detected via page inspection. Proceeding.`);
        return fillWorkdayForm(page, fieldAnswers, { dryRun, log, company, role });
      }

      // ── Universal adapter (catch-all) ──────────────────────────────────
      log(`[INFO] Routing to universal adapter for unrecognized portal...`);
      const universalProfile = loadUniversalProfile();
      const resumePath = fieldAnswers.resumePath ?? null;
      const result = await fillUniversalForm(page, {
        profileData: universalProfile,
        sseEmit: log,
        resumePath,
      });
      return {
        filled: result.filled,
        skipped: result.skipped,
        warnings: result.needsHuman.map(l => `Needs human input: ${l}`),
        screenshotPath: null, ats: 'universal', jobUrl: page.url(), company, role,
      };
    }
  }
}

// ── Submit dispatcher ─────────────────────────────────────────────────────────

async function dispatchSubmit(atsType, page, log) {
  switch (atsType) {
    case 'greenhouse': return submitGreenhouseForm(page, log);

    case 'ashby': {
      const r = await submitAshbyForm(page, log);
      // Normalise to the shape index.mjs expects: { success, confirmationUrl, message }
      return { success: r.success, confirmationUrl: null, message: r.confirmationText };
    }

    case 'lever': {
      const r = await submitLeverForm(page, log);
      return { success: r.success, confirmationUrl: null, message: r.confirmationText };
    }

    case 'workday':
      return submitWorkdayForm(page, log);

    case 'linkedin': {
      const r = await submitLinkedInForm(page, log);
      return { success: r.success, confirmationUrl: null, message: r.confirmationText };
    }

    default:
      return { success: false, confirmationUrl: null, message: `Submit not implemented for ${atsType}` };
  }
}

// ── Apply click-through ─────────────────────────────────────────────────────────

/**
 * Detect whether the current page already shows a fillable application form.
 * A file input (resume upload) or several text inputs grouped together is a
 * strong signal we're on the form, not the marketing/JD page.
 */
async function hasApplicationForm(page) {
  try {
    return await page.evaluate(() => {
      if (document.querySelector('input[type="file"]')) return true;
      const inputs = document.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], textarea'
      );
      return inputs.length >= 3;
    });
  } catch {
    return false; // page may be mid-navigation
  }
}

/**
 * If the page is a job posting with an "Apply" button rather than the form
 * itself, click through to reveal the form. Handles up to 2 hops (some portals
 * have an intermediate "Apply" → "Apply manually" step) and adopts a popup tab
 * if the portal opens the form in a new window.
 *
 * Returns the page to continue with (may differ from the input if a tab opened).
 */
async function clickThroughToApplyForm(page, log, prefix) {
  // Ordered most-specific first so "apply for this job" wins over bare "apply".
  const APPLY_TEXTS = [
    'apply for this job', 'apply to this job', 'apply for this position',
    'apply manually', 'apply without', 'apply now', 'easy apply',
    "i'm interested", 'start application', 'apply',
  ];

  for (let hop = 0; hop < 2; hop++) {
    if (await hasApplicationForm(page)) {
      if (hop > 0) log(`${prefix} Application form reached.`);
      return page;
    }

    // A click may open the form in a new tab — race the click against a
    // popup event so we can adopt the new tab if one appears.
    const popupPromise = page
      .context()
      .waitForEvent('page', { timeout: 8_000 })
      .catch(() => null);

    const clicked = await page.evaluate((texts) => {
      const candidates = Array.from(
        document.querySelectorAll('a, button, [role="button"], input[type="submit"]')
      );
      for (const t of texts) {
        for (const el of candidates) {
          const label = (el.innerText || el.value || el.getAttribute('aria-label') || '')
            .trim().toLowerCase();
          if (!label || label.length > 40) continue;
          if (label === t || label.startsWith(t)) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              el.scrollIntoView({ block: 'center' });
              el.click();
              return label;
            }
          }
        }
      }
      return null;
    }, APPLY_TEXTS);

    if (!clicked) {
      log(`${prefix} No "Apply" button found — treating this page as the form.`);
      return page;
    }

    log(`${prefix} Clicked "${clicked}" — waiting for application form...`);

    const popup = await popupPromise;
    if (popup) {
      log(`${prefix} Application form opened in a new tab — switching to it.`);
      page = popup;
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    }
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(1_200);
  }

  if (!(await hasApplicationForm(page))) {
    log(`${prefix} ⚠️  Could not reach an application form after clicking "Apply" — `
      + `the adapter will try anyway, but you may need to navigate manually.`);
  }
  return page;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  // ── Validate required args ───────────────────────────────────────────
  if (!opts.url) {
    console.error('Error: --url is required.');
    console.error('Usage: node apply-engine/index.mjs --url <job-url> [--submit] [--report <path>]');
    process.exit(1);
  }

  const dryRun = opts.dryRun;
  const prefix = dryRun ? '[DRY RUN]' : '[LIVE]';

  // Custom logger — always prefixes with mode
  const log = (msg) => console.log(msg);

  console.log(`\n${'═'.repeat(55)}`);
  console.log(`  career-ops Apply Engine`);
  console.log(`  Mode: ${dryRun ? '🔒 DRY RUN (no submission)' : '🚀 LIVE SUBMISSION'}`);
  console.log(`  URL:  ${opts.url}`);
  console.log(`${'═'.repeat(55)}\n`);

  // ── 1. Detect ATS ────────────────────────────────────────────────────
  const atsType = opts.ats ?? detectAts(opts.url);
  if (!atsType) {
    console.warn(`${prefix} Could not auto-detect ATS from URL. Use --ats to specify.`);
    console.warn(`  Supported: greenhouse, ashby, lever, workday, linkedin`);
  } else {
    log(`${prefix} ATS detected: ${atsType}`);
  }

  // ── 2. Extract company/role guess from URL ───────────────────────────
  const { company: urlCompany, role: urlRole } = extractCompanyRoleFromUrl(opts.url);

  // ── 3. Locate report ─────────────────────────────────────────────────
  let reportPath = opts.reportPath;
  if (!reportPath) {
    reportPath = findReport(urlCompany, urlRole);
    if (reportPath) {
      log(`${prefix} Auto-located report: ${reportPath}`);
    } else {
      console.warn(`${prefix} No report found for "${urlCompany}". Continuing with profile data only.`);
      console.warn(`  Run the auto-pipeline first, or pass --report <path> explicitly.`);
    }
  }

  // ── 4. Load profile ───────────────────────────────────────────────────
  let profile;
  try {
    profile = loadProfile(opts.profilePath ?? undefined);
    log(`${prefix} Profile loaded: ${profile.candidate?.full_name ?? '(unnamed)'}`);
  } catch (err) {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  }

  // ── 5. Parse report ───────────────────────────────────────────────────
  let report = null;
  if (reportPath && existsSync(reportPath)) {
    try {
      report = parseReport(reportPath);
      log(`${prefix} Report loaded: ${report.company} — ${report.role} (score ${report.score ?? 'n/a'})`);

      if (report.score !== null && report.score < 4.0) {
        console.warn(`\n⚠️  Score is ${report.score}/5 — below recommended threshold of 4.0.`);
        console.warn(`   career-ops recommends against applying to low-fit roles.`);
        if (!dryRun) {
          const answer = await askConfirmation('Continue anyway? (yes/no) ');
          if (answer !== 'yes') {
            console.log('Aborted.');
            process.exit(0);
          }
        }
      }
    } catch (err) {
      console.warn(`${prefix} Could not parse report (${err.message}). Continuing with profile only.`);
    }
  }

  // Use report company/role if available, fall back to URL guess
  const company = report?.company ?? urlCompany ?? 'Unknown Company';
  const role    = report?.role    ?? urlRole    ?? 'Unknown Role';

  // ── 6. Build FieldAnswers ─────────────────────────────────────────────
  let fieldAnswers = buildFieldAnswers(profile, report ?? { sections: {}, company, role });

  // No tailored resume PDF yet — generate one for this job before filling.
  if (!fieldAnswers.resumePath) {
    log(`${prefix} No resume PDF in output/ — generating a tailored CV for this job...`);
    const gen = spawnSync('node', ['customize-cv.mjs', '--url', opts.url], {
      cwd: ROOT_DIR,
      stdio: 'inherit',
    });
    if (gen.status === 0) {
      // Re-resolve field answers so the freshly generated PDF is picked up.
      fieldAnswers = buildFieldAnswers(profile, report ?? { sections: {}, company, role });
    } else {
      console.warn(`${prefix} ⚠️  CV generation failed — resume upload will be skipped.`);
    }
  }

  log(`${prefix} Field answers built:`);
  log(`  Name:    ${fieldAnswers.firstName} ${fieldAnswers.lastName}`);
  log(`  Email:   ${fieldAnswers.email}`);
  log(`  Resume:  ${fieldAnswers.resumePath ?? '⚠️  not found'}`);
  log(`  Cover:   ${fieldAnswers.coverLetter ? `${fieldAnswers.coverLetter.length} chars` : '(none)'}`);

  if (!fieldAnswers.resumePath) {
    console.warn(`${prefix} ⚠️  No resume PDF available — resume upload will be skipped.`);
  }

  // ── 7. Launch Playwright (persistent profile per domain) ─────────────
  log(`\n${prefix} Launching browser (${opts.headless ? 'headless' : 'headed'})...`);

  const profileDir = getProfileDir(opts.url);
  mkdirSync(profileDir, { recursive: true });
  log(`${prefix} Browser profile: ${profileDir}`);

  // launchPersistentContext saves cookies/localStorage/sessions between runs
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: opts.headless,
    slowMo:   dryRun ? 0 : 50,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // `let` because clickThroughToApplyForm() may adopt a new tab if the
  // portal opens its application form in a popup.
  let page = await context.newPage();

  // Attach console output from the browser to our log
  page.on('console', msg => {
    if (msg.type() === 'error') {
      log(`[BROWSER ERROR] ${msg.text()}`);
    }
  });

  let filledForm = null;
  let screenshotPath = null;
  let submitted = false;
  let submitResult = null;

  try {
    // ── 8. Navigate ─────────────────────────────────────────────────────
    log(`${prefix} Navigating to ${opts.url}...`);
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Give JS-heavy pages (SPAs) a moment to render
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    // ── 8b. OAuth detection ──────────────────────────────────────────────
    const oauthOptions = await detectOAuthOptions(page);
    if (oauthOptions.length > 0) {
      log(`${prefix} OAuth options detected: ${oauthOptions.join(', ')}`);
      if (oauthOptions.includes('linkedin')) {
        log(`${prefix} LinkedIn OAuth available — using persistent session if active`);
      }
    }

    // ── 8c. Login wall detection ─────────────────────────────────────────
    const loginWall = await isLoginWall(page);
    if (loginWall) {
      log(`${prefix} Login wall detected — attempting login...`);
      const universalProfile = loadUniversalProfile();
      const { hostname } = new NodeURL(opts.url);
      await loginToPortal(page, hostname, universalProfile, log);
      // Re-navigate to the job URL after login
      await page.waitForTimeout(1500);
      if (!page.url().includes(opts.url.split('/').slice(-2).join('/'))) {
        await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      }
    }

    // ── 8d. Click through to the application form ───────────────────────
    // Many postings show the JD with an "Apply" call-to-action; the actual
    // form is one (or two) clicks away. Greenhouse/Lever/Ashby embed the form
    // inline, so this is a no-op there — it only fires when no form is found.
    page = await clickThroughToApplyForm(page, log, prefix);

    // ── 9. Dispatch to adapter ───────────────────────────────────────────
    const effectiveAts = atsType ?? 'unknown';
    filledForm = await dispatchAdapter(effectiveAts, page, fieldAnswers, {
      dryRun,
      log,
      company,
      role,
    });

    // ── 10. Screenshot ───────────────────────────────────────────────────
    screenshotPath = await takeScreenshot(page, company, role);
    if (screenshotPath) {
      log(`${prefix} Screenshot saved: ${screenshotPath}`);
      filledForm.screenshotPath = screenshotPath;
    }

    // ── 11. Dry-run summary ──────────────────────────────────────────────
    const reportOutPath = writeDryRunReport(filledForm, fieldAnswers, dryRun);
    log(`${prefix} Dry-run report saved: ${reportOutPath}`);

    // ── 12. Print summary ────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(55)}`);
    console.log(`  SUMMARY: ${company} — ${role}`);
    console.log(`${'─'.repeat(55)}`);
    console.log(`  ATS:             ${effectiveAts}`);
    console.log(`  Fields filled:   ${filledForm.filled.length}`);
    console.log(`  Fields skipped:  ${filledForm.skipped.length}`);
    console.log(`  Warnings:        ${filledForm.warnings.length}`);
    console.log(`  Screenshot:      ${screenshotPath ?? 'none'}`);
    console.log(`  Report:          ${reportOutPath}`);

    if (filledForm.warnings.length > 0) {
      console.log(`\n  Warnings:`);
      for (const w of filledForm.warnings) {
        console.log(`    ⚠️  ${w}`);
      }
    }

    if (filledForm.skipped.length > 0) {
      console.log(`\n  Skipped fields:`);
      for (const s of filledForm.skipped.slice(0, 10)) {
        console.log(`    –  ${s}`);
      }
      if (filledForm.skipped.length > 10) {
        console.log(`    ... and ${filledForm.skipped.length - 10} more (see dry-run report)`);
      }
    }

    console.log(`${'─'.repeat(55)}`);

    // ── 13. Dry-run exit or live submit ──────────────────────────────────
    if (dryRun) {
      console.log(`\n✅ DRY RUN COMPLETE`);
      console.log(`   Review the filled form in the browser window above.`);
      console.log(`   Run with --submit to actually submit.`);
      console.log(`   Dry-run report: ${reportOutPath}\n`);
    } else {
      // Human confirmation before submitting
      console.log(`\n⚠️  You are about to SUBMIT a live application.`);
      console.log(`   Company: ${company}`);
      console.log(`   Role:    ${role}`);
      console.log(`   URL:     ${opts.url}\n`);

      const answer = await askConfirmation('Submit this application? (yes/no) ');
      if (answer === 'yes') {
        submitResult = await dispatchSubmit(effectiveAts, page, log);

        if (submitResult.success) {
          console.log(`\n✅ APPLICATION SUBMITTED SUCCESSFULLY`);
          console.log(`   Confirmation: ${submitResult.confirmationUrl ?? 'n/a'}`);
          submitted = true;

          // Update tracker
          updateApplicationsTracker(company, role, submitResult.confirmationUrl);

          // Take post-submission screenshot
          const postScreenshot = await takeScreenshot(page, `${company}-submitted`, role);
          if (postScreenshot) console.log(`   Post-submit screenshot: ${postScreenshot}`);
        } else {
          console.error(`\n❌ SUBMISSION MAY HAVE FAILED`);
          console.error(`   ${submitResult.message}`);
          console.error(`   Check the browser window and submit manually if needed.`);
        }
      } else {
        console.log('\nSubmission cancelled. Form has been filled — you can submit manually.');
      }
    }

    // ── 14. In live mode, pause briefly so the user can see the result ───
    if (!dryRun && !opts.headless) {
      await page.waitForTimeout(3_000).catch(() => {});
    }

  } finally {
    // Close persistent context (saves session state automatically)
    await context.close();
  }

  process.exit(submitted ? 0 : (dryRun ? 0 : 1));
}

// ── Entry point ───────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(`\nFatal error: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
