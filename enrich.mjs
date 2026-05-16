#!/usr/bin/env node

/**
 * enrich.mjs — Company intelligence enrichment
 *
 * Runs after scan.mjs. For each company in pipeline.md that hasn't been
 * enriched, pulls Glassdoor ratings, Levels.fyi salary data, and LinkedIn
 * recruiter contacts (via Google search — avoids the LinkedIn auth wall).
 *
 * Saves to:  data/intel/<slug>.json        (one file per company)
 * Updates:   data/intel-index.json         (summary index for webui)
 *
 * Usage:
 *   node enrich.mjs                        # enrich all unenriched companies
 *   node enrich.mjs --company anthropic    # single company (slug or partial name)
 *   node enrich.mjs --force                # re-enrich even if data exists
 *   node enrich.mjs --dry-run              # show what would be fetched, don't write
 *   node enrich.mjs --skip-contacts        # skip LinkedIn contact search (faster)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import readline from 'readline';
import { chromium } from 'playwright';

// ── Constants ────────────────────────────────────────────────────────

const PIPELINE_PATH = 'data/pipeline.md';
const INTEL_DIR     = 'data/intel';
const INTEL_INDEX   = 'data/intel-index.json';

const DELAY_MIN_MS         = 1_500;
const DELAY_MAX_MS         = 4_000;
const GOOGLE_DELAY_MS      = 2_500;
const GD_RETRY_WAIT_MS     = 30_000;
const NAV_TIMEOUT_MS       = 25_000;
const MAX_CONTACTS         = 5;

// ── CLI flags ────────────────────────────────────────────────────────

const args          = process.argv.slice(2);
const DRY_RUN       = args.includes('--dry-run');
const FORCE         = args.includes('--force');
const SKIP_CONTACTS = args.includes('--skip-contacts');

const companyFlag   = args.indexOf('--company');
const FILTER        = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

// ── Helpers ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomDelay(min = DELAY_MIN_MS, max = DELAY_MAX_MS) {
  return sleep(Math.floor(Math.random() * (max - min)) + min);
}

// ── CAPTCHA detection & interactive resolver ─────────────────────────

const MAX_CAPTCHA_ATTEMPTS = 3;

/**
 * Check whether the current page is showing a CAPTCHA or bot challenge.
 * If detected, pauses and prompts the user to solve it in the headed browser
 * window, then waits for Enter before continuing. Retries up to
 * MAX_CAPTCHA_ATTEMPTS times. Returns true if a CAPTCHA was found (and
 * resolved), false if no CAPTCHA was present, or throws after too many
 * failed attempts (caller should treat this as a skip signal).
 */
async function checkForCaptcha(page, url) {
  const CAPTCHA_SELECTORS = [
    'iframe[src*="captcha"]',
    'iframe[src*="recaptcha"]',
    '[data-cy="captcha"]',
    '#captcha',
    '.g-recaptcha',
    'div[class*="challenge"]',
  ];
  const CAPTCHA_PHRASES = [
    'just a moment',
    'attention required',
    'verify you are human',
    'checking your browser',
  ];

  async function isCaptchaPresent() {
    // Check known CAPTCHA DOM selectors
    for (const sel of CAPTCHA_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (el) return true;
      } catch { /* page may be mid-navigation */ }
    }
    // Check page title for challenge phrases
    try {
      const title = (await page.title()).toLowerCase();
      if (CAPTCHA_PHRASES.some((p) => title.includes(p))) return true;
    } catch { /* ignore */ }
    // Check first 500 chars of body text
    try {
      const body = await page.evaluate(
        () => document.body?.innerText?.substring(0, 500)?.toLowerCase() ?? ''
      );
      if (CAPTCHA_PHRASES.some((p) => body.includes(p))) return true;
    } catch { /* ignore */ }
    return false;
  }

  if (!(await isCaptchaPresent())) return false;

  // CAPTCHA is present — hand off to the human
  for (let attempt = 1; attempt <= MAX_CAPTCHA_ATTEMPTS; attempt++) {
    process.stdout.write(
      `\n⚠️  CAPTCHA detected on ${url}\n` +
      `   Solve it in the browser window, then press ENTER to continue...\n`
    );

    await new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin });
      rl.once('line', () => { rl.close(); resolve(); });
    });

    await sleep(2_000); // brief pause after Enter so the page can settle

    if (!(await isCaptchaPresent())) {
      console.log('   ✓ CAPTCHA resolved — continuing.\n');
      return true;
    }

    if (attempt < MAX_CAPTCHA_ATTEMPTS) {
      console.log(
        `   ✗ CAPTCHA still present (attempt ${attempt}/${MAX_CAPTCHA_ATTEMPTS}) — try again.`
      );
    } else {
      throw new Error(
        `CAPTCHA not resolved after ${MAX_CAPTCHA_ATTEMPTS} attempts on ${url} — skipping`
      );
    }
  }

  return true; // unreachable but keeps the linter happy
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Capitalize each word; clean URL-slugified names like "john-doe" → "John Doe" */
function formatName(raw) {
  if (!raw) return 'Unknown';
  return raw
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .substring(0, 60)
    .trim();
}

// ── Pipeline parser ──────────────────────────────────────────────────

/**
 * Parse pipeline.md and return an array of unique company objects.
 * Each object: { slug, name, primaryRole, allRoles }
 */
function parsePipelineCompanies() {
  if (!existsSync(PIPELINE_PATH)) {
    console.error(`✗ ${PIPELINE_PATH} not found. Run scan.mjs first.`);
    process.exit(1);
  }

  const text     = readFileSync(PIPELINE_PATH, 'utf-8');
  const bySlug   = new Map(); // slug → { name, roles: Set }

  // Lines look like: - [ ] https://... | Company | Role Title
  for (const m of text.matchAll(/- \[[ x]\] https?:\/\/\S+ \| ([^|]+) \| (.+)/g)) {
    const name = m[1].trim();
    const role = m[2].trim();
    const slug = slugify(name);

    if (!bySlug.has(slug)) bySlug.set(slug, { name, roles: new Set() });
    bySlug.get(slug).roles.add(role);
  }

  const companies = [];
  for (const [slug, { name, roles }] of bySlug) {
    const allRoles    = [...roles];
    const primaryRole = pickPrimaryRole(allRoles);
    companies.push({ slug, name, primaryRole, allRoles });
  }
  return companies;
}

/** Choose the most resume-relevant role from a company's pipeline entries */
function pickPrimaryRole(roles) {
  const priority = [
    'Solutions Engineer',
    'Applied AI Engineer',
    'Forward Deployed Engineer',
    'Technical Account Manager',
    'Software Engineer',
    'Technical Solutions Engineer',
    'Developer Advocate',
  ];
  for (const p of priority) {
    const hit = roles.find((r) => r.toLowerCase().includes(p.toLowerCase()));
    if (hit) return hit;
  }
  return roles[0] ?? 'Software Engineer';
}

/** Normalize a role name to a clean salary-lookup form */
function normalizeRole(roleName) {
  const lower = roleName.toLowerCase();
  if (lower.includes('solutions engineer'))   return 'Solutions Engineer';
  if (lower.includes('applied ai'))           return 'Applied AI Engineer';
  if (lower.includes('forward deployed'))     return 'Forward Deployed Engineer';
  if (lower.includes('account manager'))      return 'Technical Account Manager';
  if (lower.includes('software engineer'))    return 'Software Engineer';
  if (lower.includes('developer advocate'))   return 'Developer Advocate';
  return roleName;
}

// ── Playwright factory ───────────────────────────────────────────────

/** Launch a headed Chromium with automation flags suppressed */
async function launchBrowser() {
  return chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ],
  });
}

/**
 * Open a fresh browser context with realistic headers.
 * Returns a ready page.
 */
async function stealthPage(browser) {
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:     'en-US',
    timezoneId: 'America/Chicago',
    viewport:   { width: 1280, height: 800 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Mask the webdriver fingerprint
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Stub chrome.runtime so navigator.plugins check passes
    window.chrome = { runtime: {} };
    // Fool headless detection
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
  });

  return ctx.newPage();
}

// ── Glassdoor scraper ────────────────────────────────────────────────

/**
 * Search Glassdoor for companyName, navigate to the Overview page,
 * and extract ratings. Returns null on failure.
 */
async function scrapeGlassdoor(browser, companyName) {
  const page = await stealthPage(browser);
  try {
    const searchUrl =
      `https://www.glassdoor.com/Search/results.htm?keyword=${encodeURIComponent(companyName)}`;

    console.log(`  [glassdoor] Search: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await randomDelay();

    // Check for CAPTCHA / bot challenge on the search results page
    await checkForCaptcha(page, searchUrl);

    // Try to click the first employer result
    const selectors = [
      'a[data-test="employer-name"]',
      'a[class*="EmployerName"]',
      `a:text-is("${companyName}")`,
      `a:has-text("${companyName}")`,
    ];

    let clicked = false;
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      // Last resort: look for any link whose text loosely matches
      const link = await page.evaluateHandle((name) => {
        const anchors = Array.from(document.querySelectorAll('a'));
        return anchors.find((a) =>
          a.textContent.trim().toLowerCase() === name.toLowerCase()
        ) ?? null;
      }, companyName);

      if (link) {
        await link.click();
        clicked = true;
      }
    }

    if (!clicked) {
      console.log(`  [glassdoor] Could not find company link for "${companyName}"`);
      return null;
    }

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      .catch(() => {}); // navigation may already be done
    await randomDelay(1_000, 2_500);

    // Check for CAPTCHA again now that we're on the company overview page
    await checkForCaptcha(page, page.url());

    const finalUrl = page.url();
    return await extractGlassdoorData(page, finalUrl);

  } catch (err) {
    if (err.message.includes('429')) {
      console.log(`  [glassdoor] 429 received — waiting ${GD_RETRY_WAIT_MS / 1000}s`);
      await sleep(GD_RETRY_WAIT_MS);
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await randomDelay(3_000, 5_000);
        return await extractGlassdoorData(page, page.url());
      } catch (retryErr) {
        console.log(`  [glassdoor] Retry failed: ${retryErr.message}`);
        return null;
      }
    }
    console.log(`  [glassdoor] Error: ${err.message}`);
    return null;
  } finally {
    await page.context().close();
  }
}

/** Extract rating data from the current Glassdoor overview page */
async function extractGlassdoorData(page, url) {
  try {
    return await page.evaluate((pageUrl) => {
      // ── Overall rating ──────────────────────────────────────────────
      const ratingSelectors = [
        '[data-test="rating-info-rating"]',
        '.rating-headline-average',
        '[class*="ratingNumber"]',
        '[class*="RatingBadge"] span',
        '.ratingNum',
        '[data-test="rating"]',
      ];
      let rating = null;
      for (const sel of ratingSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const m = el.textContent.match(/^[\d.]+$/);
          if (m) { rating = parseFloat(m[0]); break; }
          const m2 = el.textContent.match(/[\d.]+/);
          if (m2) { rating = parseFloat(m2[0]); break; }
        }
      }

      // ── CEO approval % ──────────────────────────────────────────────
      let ceoApprovalPct = null;
      const ceoSelectors = [
        '[data-test="CEO-approval-rating"]',
        '[class*="ceoApproval"]',
        '[class*="approve"]',
      ];
      for (const sel of ceoSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const m = el.textContent.match(/(\d+)%/);
          if (m) { ceoApprovalPct = parseInt(m[1]); break; }
        }
      }
      // Fallback: scan text nodes near "CEO"
      if (!ceoApprovalPct) {
        const all = Array.from(document.querySelectorAll('*'));
        for (const el of all) {
          if (el.children.length === 0 && el.textContent.includes('CEO')) {
            const parent = el.parentElement;
            if (parent) {
              const m = parent.textContent.match(/(\d+)%/);
              if (m) { ceoApprovalPct = parseInt(m[1]); break; }
            }
          }
        }
      }

      // ── Recommend % ─────────────────────────────────────────────────
      let recommendPct = null;
      const recSelectors = [
        '[data-test="recommend-to-friend-rating"]',
        '[class*="recommend"]',
      ];
      for (const sel of recSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const m = el.textContent.match(/(\d+)%/);
          if (m) { recommendPct = parseInt(m[1]); break; }
        }
      }

      // ── Sub-ratings (Culture, WLB, Mgmt, Comp, Career) ─────────────
      function subRating(keywords) {
        const labels = Array.from(
          document.querySelectorAll('[class*="RatingLabel"], [class*="category"], dt, li, div')
        );
        for (const el of labels) {
          const text = el.textContent.toLowerCase();
          if (keywords.some((k) => text.includes(k)) && text.length < 80) {
            // Look for a numeric rating near this element
            const candidates = [
              el.nextElementSibling,
              el.parentElement?.nextElementSibling,
              el.querySelector('[class*="rating"], [class*="Rating"]'),
              el.parentElement?.querySelector('[class*="rating"]'),
            ].filter(Boolean);
            for (const c of candidates) {
              const m = c.textContent.match(/^[\d.]+$/) || c.textContent.match(/^[\d.]+\s*\/\s*5/);
              if (m) return parseFloat(m[0]);
            }
          }
        }
        return null;
      }

      const ratings = {
        culture:            subRating(['culture', 'values']),
        work_life_balance:  subRating(['work/life', 'work-life', 'balance']),
        senior_management:  subRating(['senior management', 'management']),
        comp_benefits:      subRating(['comp', 'benefits', 'pay']),
        career_opportunities: subRating(['career', 'opportunity', 'opportunities']),
      };

      // ── Review count ────────────────────────────────────────────────
      let reviewCount = null;
      const reviewSelectors = [
        '[data-test="reviews-count"]',
        'a[href*="Reviews"]',
        '[class*="reviewCount"]',
        '[class*="ReviewCount"]',
      ];
      for (const sel of reviewSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const m = el.textContent.replace(/,/g, '').match(/(\d+)/);
          if (m) { reviewCount = parseInt(m[1]); break; }
        }
      }

      // ── Hiring / layoffs signal ─────────────────────────────────────
      const pageText = document.body?.innerText?.toLowerCase() ?? '';
      const isHiring   = pageText.includes('actively hiring') || pageText.includes('open positions');
      const hasLayoffs = pageText.includes('layoff') || pageText.includes('reduction in force');

      return {
        rating,
        ceo_approval_pct: ceoApprovalPct,
        recommend_pct:    recommendPct,
        ratings,
        review_count: reviewCount,
        hiring_signal: isHiring ? 'hiring' : hasLayoffs ? 'layoffs_mentioned' : null,
        url: pageUrl,
      };
    }, url);
  } catch (err) {
    console.log(`  [glassdoor] Extract error: ${err.message}`);
    return null;
  }
}

// ── Levels.fyi scraper ───────────────────────────────────────────────

/**
 * Try several slug variants for the company on Levels.fyi and extract
 * salary data for the given role. Returns null if no data found.
 */
async function scrapeLevelsFyi(browser, company, roleName) {
  const page = await stealthPage(browser);
  try {
    // Levels.fyi slugs are usually lowercase no-dash (e.g. "openai", "anthropic")
    const slugVariants = [
      company.slug,                                 // e.g. "unity-technologies"
      company.slug.replace(/-/g, ''),               // "unitytechnologies"
      company.slug.split('-')[0],                   // "unity"
      company.name.toLowerCase().replace(/\s+/g, ''), // "unitytechnologies"
    ].filter((v, i, a) => a.indexOf(v) === i);     // dedupe

    for (const variant of slugVariants) {
      const url = `https://www.levels.fyi/companies/${variant}/salaries/`;
      console.log(`  [levels.fyi] Trying: ${url}`);

      try {
        const resp = await page.goto(url, {
          waitUntil: 'networkidle',
          timeout: NAV_TIMEOUT_MS,
        });

        if (resp && resp.status() === 404) {
          console.log(`  [levels.fyi] 404 for ${variant}`);
          continue;
        }

        // Wait for React to hydrate, then check for CAPTCHA
        await randomDelay(1_500, 3_000);
        await checkForCaptcha(page, url);

        const data = await extractLevelsFyiData(page, roleName);
        if (data && (data.median_total || data.median_base)) {
          data.source = 'levels.fyi';
          data.url    = url;
          data.role   = normalizeRole(roleName);
          return data;
        }

        console.log(`  [levels.fyi] No salary data at ${variant}`);
      } catch (err) {
        console.log(`  [levels.fyi] Error for ${variant}: ${err.message}`);
        continue;
      }
    }
    return null;
  } finally {
    await page.context().close();
  }
}

async function extractLevelsFyiData(page, _roleName) {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? '';

    // Parse dollar amounts: "$145K" or "$145,000" or "145K"
    function parseDollar(raw) {
      if (!raw) return null;
      // Remove commas, strip $
      const cleaned = raw.replace(/[$,]/g, '');
      const m = cleaned.match(/^([\d.]+)\s*[Kk]?$/);
      if (!m) return null;
      let val = parseFloat(m[1]);
      // If value looks like it's in thousands (< 2000), multiply
      if (val < 2_000) val *= 1_000;
      return Math.round(val);
    }

    // Look for patterns like "Median: $185K" or "$185K" near "total comp"
    function findAmount(patterns) {
      for (const re of patterns) {
        const m = text.match(re);
        if (m) return parseDollar(m[1]);
      }
      return null;
    }

    const medianTotal = findAmount([
      /median[^$\n]*\$?([\d,.]+[Kk]?)/i,
      /total comp[^$\n]*\$?([\d,.]+[Kk]?)/i,
      /\$?([\d,.]+[Kk])\s*\/yr/i,
    ]);

    const p25 = findAmount([
      /25(?:th)?[^$\n]*\$?([\d,.]+[Kk]?)/i,
      /p25[^$\n]*\$?([\d,.]+[Kk]?)/i,
    ]);

    const p75 = findAmount([
      /75(?:th)?[^$\n]*\$?([\d,.]+[Kk]?)/i,
      /p75[^$\n]*\$?([\d,.]+[Kk]?)/i,
    ]);

    const medianBase = findAmount([
      /base[^$\n]*\$?([\d,.]+[Kk]?)/i,
      /salary[^$\n]*\$?([\d,.]+[Kk]?)/i,
    ]);

    // Sample size
    let sampleSize = null;
    const sampleM = text.match(/(\d[\d,]+)\s*(?:data points?|salaries?|reports?|responses?)/i);
    if (sampleM) sampleSize = parseInt(sampleM[1].replace(/,/g, ''));

    return {
      median_base:  medianBase,
      median_total: medianTotal,
      p25_total:    p25,
      p75_total:    p75,
      sample_size:  sampleSize,
    };
  });
}

// ── LinkedIn contacts via Google ─────────────────────────────────────

/**
 * Use Google site-search to find LinkedIn profiles of recruiters /
 * hiring managers at the company. Returns up to MAX_CONTACTS results.
 *
 * Two queries per company with 2-second delay between them.
 */
async function searchLinkedInContacts(browser, companyName, roleName) {
  if (SKIP_CONTACTS) return [];

  const page = await stealthPage(browser);
  const contacts = [];

  const queries = [
    `site:linkedin.com/in "${companyName}" recruiter "talent acquisition"`,
    `site:linkedin.com/in "${companyName}" "${normalizeRole(roleName)}" hiring manager`,
  ];

  try {
    for (const query of queries) {
      if (contacts.length >= MAX_CONTACTS) break;

      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=5`;
      console.log(`  [contacts] ${query.substring(0, 70)}...`);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await sleep(GOOGLE_DELAY_MS);

        // Check for Google's CAPTCHA / bot challenge before scraping results
        await checkForCaptcha(page, url);

        const results = await page.evaluate(() => {
          const found = [];

          // Primary: look for LinkedIn anchors in search results
          document.querySelectorAll('a[href*="linkedin.com/in"]').forEach((link) => {
            const href = link.href.split('?')[0]; // strip UTM params
            if (!href.includes('linkedin.com/in/')) return;
            if (found.some((f) => f.linkedin_url === href)) return;

            // Try to get a human name from surrounding text
            const container = link.closest('div[class]') ?? link.parentElement;
            const headingEl = container?.querySelector('h3') ?? link;
            const rawName   = headingEl.textContent.trim();

            // URL slug fallback: /in/jane-doe → "Jane Doe"
            const urlMatch  = href.match(/\/in\/([^/]+)/);
            const urlName   = urlMatch ? urlMatch[1] : null;

            found.push({ linkedin_url: href, raw_name: rawName || urlName });
          });

          return found.slice(0, 5);
        });

        // Annotate with inferred title based on query type
        const titleHint = query.includes('recruiter') ? 'Technical Recruiter' : 'Hiring Manager';
        for (const r of results) {
          if (!contacts.some((c) => c.linkedin_url === r.linkedin_url)) {
            contacts.push({
              name:         formatName(r.raw_name),
              title:        titleHint,
              linkedin_url: r.linkedin_url,
            });
          }
          if (contacts.length >= MAX_CONTACTS) break;
        }

      } catch (err) {
        console.log(`  [contacts] Query error: ${err.message}`);
      }

      await sleep(GOOGLE_DELAY_MS);
    }
  } finally {
    await page.context().close();
  }

  return contacts.slice(0, MAX_CONTACTS);
}

// ── Intel index ──────────────────────────────────────────────────────

function loadIntelIndex() {
  if (existsSync(INTEL_INDEX)) {
    try { return JSON.parse(readFileSync(INTEL_INDEX, 'utf-8')); }
    catch { return {}; }
  }
  return {};
}

function saveIntelIndex(index) {
  writeFileSync(INTEL_INDEX, JSON.stringify(index, null, 2), 'utf-8');
}

function updateIntelIndex(index, slug, intel) {
  index[slug] = {
    company:           intel.company,
    slug:              intel.slug,
    enriched_at:       intel.enriched_at,
    glassdoor_rating:  intel.glassdoor?.rating      ?? null,
    recommend_pct:     intel.glassdoor?.recommend_pct ?? null,
    salary_role:       intel.salary?.role           ?? null,
    salary_p25:        intel.salary?.p25_total      ?? null,
    salary_median:     intel.salary?.median_total   ?? null,
    salary_p75:        intel.salary?.p75_total      ?? null,
    contacts_count:    intel.contacts?.length       ?? 0,
    top_contact:       intel.contacts?.[0]          ?? null,
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('Career-Ops · Company Enrichment');
  console.log('═'.repeat(50));
  if (DRY_RUN) console.log('(dry run — no files will be written)\n');

  mkdirSync(INTEL_DIR, { recursive: true });

  // 1. Parse pipeline
  const allCompanies = parsePipelineCompanies();
  console.log(`Unique companies in pipeline: ${allCompanies.length}`);

  // 2. Apply --company filter
  let targets = allCompanies;
  if (FILTER) {
    targets = targets.filter(
      (c) => c.slug.includes(FILTER) || c.name.toLowerCase().includes(FILTER)
    );
    if (targets.length === 0) {
      console.error(`✗ No company matching "${FILTER}" found.`);
      process.exit(1);
    }
  }

  // 3. Skip already-enriched (unless --force)
  if (!FORCE) {
    const already = targets.filter((c) => existsSync(`${INTEL_DIR}/${c.slug}.json`));
    if (already.length > 0) {
      console.log(
        `Skipping ${already.length} already-enriched: ${already.map((c) => c.name).join(', ')}`
      );
      console.log('(Use --force to re-enrich)\n');
    }
    targets = targets.filter((c) => !existsSync(`${INTEL_DIR}/${c.slug}.json`));
  }

  if (targets.length === 0) {
    console.log('Nothing to enrich. All companies are up to date.');
    return;
  }

  console.log(`\nEnriching ${targets.length} compan${targets.length === 1 ? 'y' : 'ies'}:`);
  for (const c of targets) {
    console.log(`  • ${c.name} (${c.slug}) — primary role: ${c.primaryRole}`);
  }
  if (SKIP_CONTACTS) console.log('\n(--skip-contacts: LinkedIn search disabled)');

  if (DRY_RUN) {
    console.log('\nDry run complete. Re-run without --dry-run to write files.');
    return;
  }

  // 4. Launch browser and enrich
  const browser    = await launchBrowser();
  const intelIndex = loadIntelIndex();
  let successCount = 0;
  let errorCount   = 0;

  try {
    for (let i = 0; i < targets.length; i++) {
      const company = targets[i];
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`[${i + 1}/${targets.length}] ${company.name}`);
      console.log(`  Slug: ${company.slug} | Role: ${normalizeRole(company.primaryRole)}`);

      /** @type {import('./enrich.mjs').IntelRecord} */
      const intel = {
        company:     company.name,
        slug:        company.slug,
        enriched_at: new Date().toISOString(),
        glassdoor:   null,
        salary:      null,
        contacts:    [],
      };

      try {
        // ── 4a. Glassdoor ─────────────────────────────────────────────
        intel.glassdoor = await scrapeGlassdoor(browser, company.name);
        if (intel.glassdoor?.rating) {
          console.log(
            `  ✓ Glassdoor: ${intel.glassdoor.rating}/5 ` +
            `(${intel.glassdoor.review_count ?? '?'} reviews)`
          );
        } else {
          console.log('  ✗ Glassdoor: no data');
        }

        await randomDelay(2_000, 4_000);

        // ── 4b. Levels.fyi salary ────────────────────────────────────
        intel.salary = await scrapeLevelsFyi(browser, company, company.primaryRole);
        if (intel.salary?.median_total) {
          console.log(
            `  ✓ Salary (${intel.salary.role}): ` +
            `$${(intel.salary.median_total / 1000).toFixed(0)}K median total comp`
          );
        } else {
          console.log('  ✗ Salary: no data');
        }

        await randomDelay(2_000, 4_000);

        // ── 4c. LinkedIn contacts via Google ──────────────────────────
        if (!SKIP_CONTACTS) {
          intel.contacts = await searchLinkedInContacts(
            browser,
            company.name,
            company.primaryRole
          );
          console.log(`  ✓ Contacts: ${intel.contacts.length} found`);
        }

        // ── 4d. Save ──────────────────────────────────────────────────
        const path = `${INTEL_DIR}/${company.slug}.json`;
        writeFileSync(path, JSON.stringify(intel, null, 2), 'utf-8');
        console.log(`  → Saved: ${path}`);

        updateIntelIndex(intelIndex, company.slug, intel);
        saveIntelIndex(intelIndex);

        successCount++;
      } catch (err) {
        console.log(`  ✗ Fatal error enriching ${company.name}: ${err.message}`);
        errorCount++;
      }

      // Pace between companies
      if (i < targets.length - 1) await randomDelay(3_000, 6_000);
    }
  } finally {
    await browser.close();
  }

  // 5. Summary
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Enrichment complete — ${new Date().toISOString().slice(0, 10)}`);
  console.log(`${'═'.repeat(50)}`);
  console.log(`Enriched successfully: ${successCount}`);
  console.log(`Errors:                ${errorCount}`);
  console.log(`Intel files:           ${INTEL_DIR}/`);
  console.log(`Index:                 ${INTEL_INDEX}`);
  console.log(`\n→ Open webui/index.html (served via: npx serve .) to view company intel`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
