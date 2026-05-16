#!/usr/bin/env node

/**
 * search.mjs — Job Board Discovery Scanner
 *
 * Uses Playwright (headed) to scrape Indeed, LinkedIn, Glassdoor, and ZipRecruiter
 * for relevant roles, deduplicates against existing history, and appends new
 * offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure browser automation.
 *
 * Usage:
 *   node search.mjs                              # all queries, all boards
 *   node search.mjs --query "TAM remote"         # single custom query
 *   node search.mjs --boards indeed,linkedin     # specific boards only
 *   node search.mjs --dry-run                    # preview without writing files
 *   node search.mjs --limit 50                   # cap results per board/query (default 25)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { chromium } from 'playwright';
import yaml from 'js-yaml';

// ── Paths ────────────────────────────────────────────────────────────

const PORTALS_PATH    = 'portals.yml';
const PROFILE_PATH    = 'config/profile.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH   = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const ACTIVE_FILTER_PATH = 'data/.active-title-filter.json';

mkdirSync('data', { recursive: true });

// ── Location filter ──────────────────────────────────────────────────

const DFW_CITIES = [
  'dallas', 'fort worth', 'arlington', 'plano', 'irving',
  'southlake', 'grapevine', 'frisco', 'mckinney', 'denton',
  'garland', 'carrollton', 'richardson', 'lewisville', 'flower mound',
  'allen', 'dfw', 'north texas', 'tarrant', 'collin county',
];

const REMOTE_KEYWORDS = [
  'remote', 'work from home', 'wfh', 'anywhere', 'distributed',
  'virtual', 'telecommute', 'home-based', 'home based', 'fully remote',
];

/**
 * Returns true if this location is acceptable for Cole:
 * Mode controls what's allowed:
 *   remote-or-dfw (default): Remote OR DFW area — broadest pool
 *   remote-only: must contain remote keyword
 *   dfw-only: must be in DFW metro
 */
function isLocationAcceptable(location, mode = 'remote-or-dfw') {
  if (!location || location.trim() === '') return true; // no location = keep
  const loc = location.toLowerCase();

  const isRemote = REMOTE_KEYWORDS.some(kw => loc.includes(kw));
  const isDfw = DFW_CITIES.some(city => loc.includes(city));
  const isNational = /^(united states|usa?|u\.s\.a?\.?|anywhere,?\s*us)$/i.test(loc.trim());

  if (mode === 'remote-only') return isRemote;
  if (mode === 'dfw-only')    return isDfw;
  // remote-or-dfw (default)
  return isRemote || isDfw || isNational;
}

// ── Title filter ─────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup ────────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv — first column is URL, skip header row
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) {
      const url = line.split('\t')[0]?.trim();
      if (url) seen.add(url);
    }
  }

  // pipeline.md — URLs after "- [ ] " or "- [x] "
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — any inline URL
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

/**
 * Build a set of normalized company names that already have ATS tracking in
 * portals.yml (careers_url or api). Jobs from these companies will be skipped —
 * scan.mjs already covers them via direct API.
 */
function buildTrackedCompanySet(config) {
  const tracked = new Set();
  for (const c of config.tracked_companies || []) {
    if (c.careers_url || c.api) {
      tracked.add(normalizeCompanyName(c.name));
    }
  }
  return tracked;
}

function normalizeCompanyName(name) {
  return name
    .toLowerCase()
    .replace(/,?\s*(inc|llc|ltd|corp|corporation|co|technologies|labs?|ai)\b\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns true if the job's company is already tracked in portals.yml via ATS */
function isCompanyTracked(company, trackedSet) {
  const norm = normalizeCompanyName(company);
  for (const tracked of trackedSet) {
    if (norm.includes(tracked) || tracked.includes(norm)) return true;
  }
  return false;
}

// ── URL normalizer ────────────────────────────────────────────────────

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url.startsWith('http') ? url : 'https:' + url);
    // Strip common tracking parameters
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content',
                      'refId', 'trk', 'trackingId', 'from', 'hl']) {
      u.searchParams.delete(p);
    }
    return u.href;
  } catch {
    return url;
  }
}

// ── Pipeline writer ───────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8') : '';
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);

  const block = '\n' + offers.map(o =>
    `- [ ] ${o.url} | ${o.company} | ${o.title} | source:${o.source}`
  ).join('\n') + '\n';

  if (idx === -1) {
    // No Pendientes section — create it at top
    text = `${marker}\n${block}\n` + text;
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH,
      'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }
  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Timing helpers ────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min = 1000, max = 3000) =>
  sleep(min + Math.random() * (max - min));

// ── Board scrapers ────────────────────────────────────────────────────
//
// Each scraper receives (page, query, limit) and returns an array of:
//   { title, company, location, url, source }
//
// Scrapers are intentionally tolerant — multiple selector fallbacks,
// try/catch per card so one bad card doesn't kill the whole run.
// ─────────────────────────────────────────────────────────────────────

async function scrapeIndeed(page, query, limit) {
  const results = [];
  const encoded = encodeURIComponent(query);
  // remotejobs=1  → Indeed "remote only" filter
  // sort=date     → newest first
  // fromage=14    → posted in last 14 days
  const url = `https://www.indeed.com/jobs?q=${encoded}&remotejobs=1&sort=date&fromage=14`;

  console.log(`    URL: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    console.warn(`    ✗ Navigation error: ${e.message}`);
    return results;
  }
  await randomDelay(2000, 4000);

  // Dismiss modal / overlay if present
  try {
    const closeBtn = page
      .locator('[aria-label="close"], [data-testid="modal-close"], .icl-CloseButton, button[aria-label="Close"]')
      .first();
    if (await closeBtn.isVisible({ timeout: 2000 })) await closeBtn.click();
  } catch { /* no modal — fine */ }

  // Indeed job cards have a data-jk attribute (the job key)
  const cards = await page.locator('[data-jk]').all();
  console.log(`    Found ${cards.length} cards`);

  for (const card of cards.slice(0, limit)) {
    try {
      const jk = await card.getAttribute('data-jk');
      if (!jk) continue;

      // Title: prefer span[title] (most stable), fallback to text content
      const titleEl = card
        .locator('.jobTitle span[title], .jobTitle a span, [data-testid="job-title"] span, h2.jobTitle span')
        .first();
      const title = (await titleEl.innerText().catch(() => '')).trim();

      const company = (await card
        .locator('.companyName, [data-testid="company-name"], .css-92r8pb')
        .first().innerText().catch(() => '')).trim();

      const location = (await card
        .locator('.companyLocation, [data-testid="text-location"], .css-1restlb')
        .first().innerText().catch(() => '')).trim();

      if (!title || !company) continue;

      results.push({
        title,
        company,
        location,
        url: `https://www.indeed.com/viewjob?jk=${jk}`,
        source: 'indeed',
      });
    } catch { /* skip bad card */ }
  }

  return results;
}

async function scrapeLinkedIn(page, query, limit) {
  const results = [];
  const encoded = encodeURIComponent(query);
  // f_WT=2 = remote jobs filter; sortBy=DD = date descending
  const url = `https://www.linkedin.com/jobs/search/?keywords=${encoded}&location=Remote&f_WT=2&sortBy=DD`;

  console.log(`    URL: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    console.warn(`    ✗ Navigation error: ${e.message}`);
    return results;
  }
  await randomDelay(2000, 4000);

  // LinkedIn may show a login gate — try to scrape what's visible anyway.
  // Public job listings are accessible without login on many searches.
  const cards = await page
    .locator('.job-card-container, .jobs-search__results-list li, .base-card')
    .all();
  console.log(`    Found ${cards.length} cards${cards.length === 0 ? ' (login wall?)' : ''}`);

  for (const card of cards.slice(0, limit)) {
    try {
      const title = (await card
        .locator('.job-card-list__title, .base-search-card__title, .job-card-container__link')
        .first().innerText().catch(() => '')).trim();

      const company = (await card
        .locator('.job-card-container__company-name, .base-search-card__subtitle, .job-card-container__primary-description, .job-card-container__company-url')
        .first().innerText().catch(() => '')).trim();

      const location = (await card
        .locator('.job-card-container__metadata-item, .job-search-card__location, .job-card-list__entity-lockup .artdeco-entity-lockup__caption')
        .first().innerText().catch(() => '')).trim();

      // Grab href from the title anchor
      const anchor = card
        .locator('a[href*="/jobs/view/"], a.job-card-list__title, a.base-card__full-link')
        .first();
      let jobUrl = (await anchor.getAttribute('href').catch(() => '')) || '';
      if (jobUrl && !jobUrl.startsWith('http')) {
        jobUrl = 'https://www.linkedin.com' + jobUrl;
      }

      if (!title || !company || !jobUrl) continue;

      results.push({
        title,
        company,
        location,
        url: normalizeUrl(jobUrl),
        source: 'linkedin',
      });
    } catch { /* skip bad card */ }
  }

  return results;
}

async function scrapeGlassdoor(page, query, limit) {
  const results = [];
  const encoded = encodeURIComponent(query);
  // locT=N + locId=1 = national (USA); remoteWorkType=1 = remote
  const url =
    `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encoded}` +
    `&locT=N&locId=1&remoteWorkType=1&sortBy=date_desc`;

  console.log(`    URL: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    console.warn(`    ✗ Navigation error: ${e.message}`);
    return results;
  }
  await randomDelay(2000, 4000);

  // Dismiss cookie / GDPR banners
  try {
    const cookieBtn = page
      .locator('button[id*="onetrust-accept"], [aria-label*="cookie"], .gdpr-btn, #onetrust-accept-btn-handler')
      .first();
    if (await cookieBtn.isVisible({ timeout: 2000 })) await cookieBtn.click();
  } catch { /* no banner */ }

  // Glassdoor listing selectors have changed over time — try multiple
  const cards = await page
    .locator('li.react-job-listing, [data-test="jobListing"], article[data-id], .job-listing-item')
    .all();
  console.log(`    Found ${cards.length} cards`);

  for (const card of cards.slice(0, limit)) {
    try {
      // Title link
      const titleEl = card
        .locator('[data-test="job-link"], .job-title a, [class*="jobTitle"] a, a[class*="JobLink"]')
        .first();
      const title = (await titleEl.innerText().catch(() => '')).trim();

      const company = (await card
        .locator('.employer-name, [class*="EmployerName"], [data-test="employer-name"], .jobHeader .employer')
        .first().innerText().catch(() => '')).trim();

      const location = (await card
        .locator('[data-test="location"], .location, [class*="Location"]')
        .first().innerText().catch(() => '')).trim();

      let jobUrl = (await titleEl.getAttribute('href').catch(() => '')) || '';
      if (!jobUrl) {
        jobUrl = (await card.locator('a').first().getAttribute('href').catch(() => '')) || '';
      }
      if (jobUrl && !jobUrl.startsWith('http')) {
        jobUrl = 'https://www.glassdoor.com' + jobUrl;
      }

      if (!title || !company || !jobUrl) continue;

      results.push({
        title,
        company,
        location,
        url: normalizeUrl(jobUrl),
        source: 'glassdoor',
      });
    } catch { /* skip bad card */ }
  }

  return results;
}

async function scrapeZipRecruiter(page, query, limit) {
  const results = [];
  const encoded = encodeURIComponent(query);
  // days=14 = recent only; order_by=posted_date = newest first
  const url =
    `https://www.ziprecruiter.com/jobs-search?search=${encoded}` +
    `&location=Remote&days=14&order_by=posted_date`;

  console.log(`    URL: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    console.warn(`    ✗ Navigation error: ${e.message}`);
    return results;
  }
  await randomDelay(2000, 4000);

  const cards = await page
    .locator('article.job_result, .job_content, [class*="job-card"], li[class*="JobListItem"]')
    .all();
  console.log(`    Found ${cards.length} cards`);

  for (const card of cards.slice(0, limit)) {
    try {
      const titleEl = card
        .locator('h2 a, .job_title a, [class*="jobTitle"] a, a[data-job-title], [class*="JobTitle"] a')
        .first();
      const title = (await titleEl.innerText().catch(() => '')).trim();

      const company = (await card
        .locator('.hiring_company_text, [class*="company"], [class*="employer"], [class*="Company"]')
        .first().innerText().catch(() => '')).trim();

      const location = (await card
        .locator('[class*="location"], .location_text, [class*="Location"]')
        .first().innerText().catch(() => '')).trim();

      let jobUrl = (await titleEl.getAttribute('href').catch(() => '')) || '';
      if (jobUrl && !jobUrl.startsWith('http')) {
        jobUrl = 'https://www.ziprecruiter.com' + jobUrl;
      }

      if (!title || !company || !jobUrl) continue;

      results.push({
        title,
        company,
        location,
        url: normalizeUrl(jobUrl),
        source: 'ziprecruiter',
      });
    } catch { /* skip bad card */ }
  }

  return results;
}

// ── Board registry ────────────────────────────────────────────────────

// Only boards with an implemented scraper are registered here. Adding a key
// for a function that doesn't exist throws a ReferenceError at module load.
const BOARD_SCRAPERS = {
  indeed:          scrapeIndeed,
  linkedin:        scrapeLinkedIn,
  glassdoor:       scrapeGlassdoor,
  ziprecruiter:    scrapeZipRecruiter,
};

// ── Build search queries from profile.yml ─────────────────────────────

function buildQueries(profile) {
  const primaryRoles = profile?.target_roles?.primary ?? [
    'Field Applications Scientist',
    'Technical Account Manager',
    'AI Engineer',
    'Solutions Engineer',
    'Developer Relations Engineer',
    'Customer Success Engineer',
  ];

  const remoteQueries = primaryRoles.map(role => `${role} remote`);

  // DFW-specific searches (office roles Cole could commute to)
  const dfwQueries = [
    'Solutions Engineer Dallas',
    'Technical Account Manager Fort Worth',
    'Field Applications Scientist Texas',
    'Customer Success Engineer Dallas',
    'AI Engineer Dallas Texas',
  ];

  return [...remoteQueries, ...dfwQueries];
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun    = args.includes('--dry-run');

  // --query "some query string"
  const qIdx      = args.indexOf('--query');
  const customQuery = qIdx !== -1 ? args[qIdx + 1] : null;

  // --boards indeed,linkedin
  const bIdx      = args.indexOf('--boards');
  const boardFilter = bIdx !== -1
    ? args[bIdx + 1].split(',').map(s => s.trim().toLowerCase())
    : Object.keys(BOARD_SCRAPERS);

  // --limit N
  const lIdx      = args.indexOf('--limit');
  const limit     = lIdx !== -1 ? parseInt(args[lIdx + 1], 10) || 25 : 25;

  // --location-mode remote-or-dfw | remote-only | dfw-only
  const locModeIdx  = args.indexOf('--location-mode');
  const locationMode = locModeIdx !== -1 ? args[locModeIdx + 1] : 'remote-or-dfw';

  // --extra-positive "kw1,kw2"  --extra-negative "kw1,kw2"
  const epIdx = args.indexOf('--extra-positive');
  const extraPositive = epIdx !== -1 ? args[epIdx + 1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
  const enIdx = args.indexOf('--extra-negative');
  const extraNegative = enIdx !== -1 ? args[enIdx + 1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];

  // ── Load configs ─────────────────────────────────────────────────

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found.');
    process.exit(1);
  }

  const config  = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const profile = existsSync(PROFILE_PATH)
    ? yaml.load(readFileSync(PROFILE_PATH, 'utf-8'))
    : null;

  // Load active title filter: check temp file first, fall back to portals.yml
  let activeTitleFilter = config.title_filter;
  if (existsSync(ACTIVE_FILTER_PATH)) {
    try {
      const preset = JSON.parse(readFileSync(ACTIVE_FILTER_PATH, 'utf-8'));
      activeTitleFilter = preset;
      console.log(`  Using active preset filter: ${preset.label || 'custom'}`);
    } catch { /* fall back to portals.yml filter */ }
  }
  // Merge extra keywords from CLI (--extra-positive / --extra-negative)
  const mergedFilter = {
    positive: [...(activeTitleFilter?.positive || []), ...extraPositive],
    negative: [...(activeTitleFilter?.negative || []), ...extraNegative],
  };
  const titleFilter = buildTitleFilter(mergedFilter);
  const trackedCompanies = buildTrackedCompanySet(config);
  const seenUrls        = loadSeenUrls();

  const queries      = customQuery ? [customQuery] : buildQueries(profile);
  const activeBoards = boardFilter.filter(b => BOARD_SCRAPERS[b]);

  if (activeBoards.length === 0) {
    console.error(`No valid boards specified. Available: ${Object.keys(BOARD_SCRAPERS).join(', ')}`);
    process.exit(1);
  }

  const date = new Date().toISOString().slice(0, 10);

  console.log(`\nJob Board Search — ${date}`);
  console.log(`${'━'.repeat(50)}`);
  console.log(`Boards:   ${activeBoards.join(', ')}`);
  console.log(`Queries:  ${queries.length} (${queries.slice(0, 2).join(', ')}${queries.length > 2 ? '…' : ''})`);
  console.log(`Limit:    ${limit} per board/query`);
  console.log(`Location: ${locationMode}`);
  if (dryRun) console.log('Mode:     DRY RUN — nothing will be written\n');
  else        console.log('');

  // ── Launch headed Playwright browser ─────────────────────────────
  // Headed (not headless) — Indeed and LinkedIn detect headless browsers.
  // Sequential requests, not parallel — rate-limit friendly.

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ],
  });

  const context = await browser.newContext({
    userAgent: [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'AppleWebKit/537.36 (KHTML, like Gecko)',
      'Chrome/124.0.0.0 Safari/537.36',
    ].join(' '),
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });

  // Suppress webdriver flag so anti-bot checks don't flag us
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
  });

  const page = await context.newPage();
  const rawResults = [];
  let totalScraped = 0;
  const errors = [];

  // ── Scrape: sequential boards, sequential queries ─────────────────

  for (const board of activeBoards) {
    const scraper = BOARD_SCRAPERS[board];
    console.log(`\n── ${board.toUpperCase()} `+ '─'.repeat(40 - board.length));

    for (const query of queries) {
      console.log(`  Query: "${query}"`);
      try {
        const results = await scraper(page, query, limit);
        totalScraped += results.length;
        rawResults.push(...results);
        console.log(`  → ${results.length} scraped`);
      } catch (err) {
        console.warn(`  ✗ Scraper error: ${err.message}`);
        errors.push({ board, query, error: err.message });
      }

      // 1.5–3s between queries (same board)
      await randomDelay(1500, 3000);
    }

    // Extra 2–4s gap between boards
    if (activeBoards.indexOf(board) < activeBoards.length - 1) {
      await randomDelay(2000, 4000);
    }
  }

  await browser.close();

  // ── Post-processing: filter + dedup ──────────────────────────────

  let filteredLocation = 0;
  let filteredTitle    = 0;
  let filteredCompany  = 0;
  let filteredDupe     = 0;
  const newOffers      = [];
  const seenThisRun    = new Set(); // intra-run dedup

  for (const job of rawResults) {
    if (!job.title || !job.url) continue;

    // 1. Location: keep Remote + DFW only
    if (!isLocationAcceptable(job.location, locationMode)) {
      filteredLocation++;
      continue;
    }

    // 2. Title: must match portals.yml title_filter
    if (!titleFilter(job.title)) {
      filteredTitle++;
      continue;
    }

    // 3. Company: skip if already tracked in portals.yml via ATS API
    if (isCompanyTracked(job.company, trackedCompanies)) {
      filteredCompany++;
      continue;
    }

    // 4. URL dedup: against history + pipeline + this run
    const cleanUrl = normalizeUrl(job.url);
    if (seenUrls.has(cleanUrl) || seenThisRun.has(cleanUrl)) {
      filteredDupe++;
      continue;
    }

    seenUrls.add(cleanUrl);
    seenThisRun.add(cleanUrl);
    newOffers.push({ ...job, url: cleanUrl });
  }

  // ── Write results ─────────────────────────────────────────────────

  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // ── Summary ───────────────────────────────────────────────────────

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`Job Board Search — ${date}`);
  console.log(`${'━'.repeat(50)}`);
  console.log(`Boards searched:       ${activeBoards.length}`);
  console.log(`Queries run:           ${queries.length}`);
  console.log(`Total scraped:         ${totalScraped}`);
  console.log(`Filtered (location):   ${filteredLocation} removed`);
  console.log(`Filtered (title):      ${filteredTitle} removed`);
  console.log(`Skipped (tracked co.): ${filteredCompany} removed (ATS scanner covers these)`);
  console.log(`Duplicates:            ${filteredDupe} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ [${e.board}] "${e.query}": ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      const loc = o.location ? ` | ${o.location}` : '';
      console.log(`  + [${o.source}] ${o.company} — ${o.title}${loc}`);
    }

    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  } else if (totalScraped > 0) {
    console.log('\nNo new offers — everything was filtered or already tracked.');
  } else {
    console.log('\nNo results scraped — boards may have blocked the request or changed their HTML.');
    console.log('Try running headed and watching what loads, or check --boards one at a time.');
  }

  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
  console.log('→ Run node scan.mjs to also check ATS portals (Greenhouse/Ashby/Lever).');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
