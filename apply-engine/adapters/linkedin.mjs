/**
 * apply-engine/adapters/linkedin.mjs
 *
 * Playwright adapter for LinkedIn Easy Apply.
 *
 * LinkedIn Easy Apply is a multi-step modal that launches on job listing pages
 * at https://www.linkedin.com/jobs/view/<id>/ when the job offers "Easy Apply"
 * instead of an external redirect ("Apply").
 *
 * Usage (by orchestrator):
 *   const hasEasyApply = await detectEasyApply(page);
 *   if (!hasEasyApply) return skipResult;
 *   const result = await fillLinkedInForm(page, fieldAnswers, { dryRun: true, log });
 *
 * ── Selector fragility notes ─────────────────────────────────────────────────
 * LinkedIn performs aggressive A/B testing and regular front-end rebuilds.
 * Selectors marked [FRAGILE] have historically changed every 3–12 months.
 * When a primary selector breaks, fall through to the [FALLBACK] alternatives
 * listed in comments. For truly dead selectors, use `page.evaluate()` to
 * walk the DOM by text content instead of CSS attributes.
 *
 * Session persistence:
 *   Saved to data/.linkedin-session.json after any authenticated run.
 *   Loaded via page.context().addCookies() on subsequent runs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname }                                        from 'path';
import { fileURLToPath }                                        from 'url';
import { createInterface }                                      from 'readline';

// ── Path setup ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
// adapters/ is two levels below project root (apply-engine/adapters/)
const ROOT_DIR    = join(__dirname, '..', '..');
const SESSION_FILE = join(ROOT_DIR, 'data', '.linkedin-session.json');

// ── Selector map ──────────────────────────────────────────────────────────────

const SEL = {
  // ── Easy Apply detection ─────────────────────────────────────────────
  // [FRAGILE] data-control-name A/B tests frequently.
  // [FALLBACK] Look for any <button> with text "Easy Apply".
  EASY_APPLY_BTN: [
    'button[data-control-name="jobdetails_topcard_inapply"]',
    '.jobs-apply-button--top-card',
    '.jobs-s-apply button',
  ].join(', '),

  // ── Authentication ───────────────────────────────────────────────────
  // [FRAGILE] aria-label on nav is stable but class names change.
  // [FALLBACK] Absence of #session_key (login form input) is a good signal.
  NAV_LOGGED_IN: [
    'nav[aria-label*="primary"]',
    '.global-nav__primary-items',
    '.feed-identity-module',
    '[data-test-id="nav-settings"]',
  ].join(', '),
  LOGIN_FORM: '#session_key, form.login__form, input[name="session_key"]',

  // ── Modal ────────────────────────────────────────────────────────────
  // [FRAGILE] LinkedIn sometimes uses class names like .jobs-easy-apply-modal
  //           or just div[role="dialog"]. Use role= as primary — most stable.
  // [FALLBACK] .artdeco-modal, [data-test-modal]
  MODAL: 'div[role="dialog"]',

  // ── Modal navigation buttons ─────────────────────────────────────────
  // [FRAGILE] aria-labels change with UI refreshes.
  // [FALLBACK] footer button:last-child — the rightmost footer button is always next/submit.
  BTN_NEXT: [
    'button[aria-label="Continue to next step"]',
    'button[aria-label*="next step"]',
    'footer button:has-text("Next")',
    // Generic fallback — ONLY use if nothing else matches
    '.jobs-easy-apply-modal footer button:last-of-type',
  ],
  BTN_REVIEW: [
    'button[aria-label="Review your application"]',
    'footer button:has-text("Review")',
  ],
  BTN_SUBMIT: [
    'button[aria-label="Submit application"]',
    'button[aria-label*="Submit"]',
    'footer button:has-text("Submit application")',
    // [FALLBACK] DOM walk by text — last resort
    'button:has-text("Submit application")',
  ],

  // ── Contact info step ─────────────────────────────────────────────────
  // [FRAGILE] id*= pattern is stable on older LinkedIn, but newer builds
  //           use generated ids like "phoneNumber-ember123". Check by label
  //           text if this stops working.
  PHONE_INPUT: 'input[id*="phoneNumber"]',

  // ── Resume step ───────────────────────────────────────────────────────
  // [FRAGILE] The real file input is hidden; LinkedIn clicks a styled <label>
  //           or <button> to trigger it. Use setInputFiles() directly on the
  //           hidden input — Playwright supports this even when display:none.
  // [FALLBACK] Look for <label> with text "Upload resume", get its [for] target.
  RESUME_FILE_INPUT: 'input[type="file"]',
  RESUME_UPLOAD_BTN: [
    'button:has-text("Upload resume")',
    'button:has-text("Upload a different resume")',
    'label:has-text("Upload resume")',
  ].join(', '),

  // ── Post-submission confirmation ──────────────────────────────────────
  // [FRAGILE] Toast selectors change frequently. Also check body text as fallback.
  CONFIRMATION: [
    '.artdeco-toast-item--success',
    '[data-test-artdeco-toast-item]',
    '.jobs-post-apply-modal',
    '[class*="post-apply"]',
  ].join(', '),
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function truncate(s, max) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

// ── Authentication helpers ─────────────────────────────────────────────────────

/**
 * Returns true if LinkedIn considers us logged in.
 * Uses DOM inspection — faster than a network round-trip.
 */
async function isAuthenticated(page) {
  return page.evaluate((sel) => !!document.querySelector(sel), SEL.NAV_LOGGED_IN).catch(() => false);
}

/**
 * Inject saved cookies from disk into the existing browser context, then
 * reload the page. Returns true if auth state was confirmed after reload.
 *
 * NOTE: We can't reconstruct the full context with storageState when the
 * context is already open (index.mjs creates it). addCookies() is the best
 * we can do — it covers LinkedIn's session cookies, which are sufficient.
 */
async function loadSavedSession(page) {
  if (!existsSync(SESSION_FILE)) return false;

  try {
    const state = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'));
    const cookies = state.cookies ?? [];
    if (cookies.length === 0) return false;

    await page.context().addCookies(cookies);
    // Reload to activate cookies on the current page
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    return await isAuthenticated(page);
  } catch (err) {
    console.warn(`[LinkedIn] Session load failed: ${err.message}`);
    return false;
  }
}

/**
 * Persist the current browser context's cookies + localStorage to disk.
 * Called after any successful authenticated run so the next run is seamless.
 */
async function saveSession(page) {
  try {
    ensureDir(join(ROOT_DIR, 'data'));
    const state = await page.context().storageState();
    writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`[LinkedIn] Session save failed: ${err.message}`);
  }
}

/**
 * Block until the user presses Enter in the terminal.
 * Used to wait for manual login when no saved session exists.
 */
function promptForLogin() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      '\n[LinkedIn] Not logged in. Please log in manually in the browser window,\n' +
      '           then press Enter here to continue...\n> ',
      () => { rl.close(); resolve(); }
    );
  });
}

/**
 * Ensure the page is in an authenticated LinkedIn session.
 * Order of attempts:
 *   1. Already logged in (happy path)
 *   2. Inject saved cookies + reload
 *   3. Navigate to /login, pause for manual login, then save state
 *
 * Throws if authentication ultimately fails.
 */
async function ensureAuthenticated(page, log) {
  if (await isAuthenticated(page)) {
    log('[LinkedIn] Already authenticated.');
    return;
  }

  log('[LinkedIn] Not authenticated — trying saved session...');
  if (await loadSavedSession(page)) {
    log('[LinkedIn] Session restored from data/.linkedin-session.json');
    return;
  }

  log('[LinkedIn] No valid saved session. Redirecting to LinkedIn login...');
  const originalUrl = page.url();

  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await promptForLogin();

  if (!await isAuthenticated(page)) {
    throw new Error(
      'LinkedIn authentication failed — user did not complete login. ' +
      'Please log in and try again.'
    );
  }

  await saveSession(page);
  log('[LinkedIn] Login confirmed. Session saved to data/.linkedin-session.json');

  // Return to the original job page
  if (originalUrl && originalUrl !== page.url() && !originalUrl.startsWith('about:')) {
    log('[LinkedIn] Returning to job page...');
    await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  }
}

// ── Easy Apply detection ───────────────────────────────────────────────────────

/**
 * detectEasyApply — exported for use by the orchestrator.
 *
 * Returns true ONLY if the page has a LinkedIn Easy Apply button visible.
 * Returns false if:
 *   - Only an external "Apply" button is present (would redirect off-site)
 *   - No apply button at all (job may be closed or on a non-job page)
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function detectEasyApply(page) {
  try {
    // Primary: CSS selector match
    const el = page.locator(SEL.EASY_APPLY_BTN).first();
    const visible = await el.isVisible({ timeout: 5_000 }).catch(() => false);
    if (visible) return true;

    // Fallback: DOM text scan — most reliable when class names change
    // [FRAGILE] — keep this fallback; it has survived multiple LinkedIn redesigns
    return page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a'));
      return buttons.some(b => {
        const text = b.textContent?.trim() ?? '';
        return text === 'Easy Apply' || text.startsWith('Easy Apply');
      });
    }).catch(() => false);
  } catch {
    return false;
  }
}

// ── Modal helpers ──────────────────────────────────────────────────────────────

/**
 * Click the Easy Apply button and wait for the modal dialog to appear.
 */
async function openEasyApplyModal(page, log) {
  const btn = page.locator(SEL.EASY_APPLY_BTN).first();
  const visible = await btn.isVisible({ timeout: 5_000 }).catch(() => false);

  if (!visible) {
    // One more try with text-based fallback
    const textBtn = page.locator('button:has-text("Easy Apply")').first();
    const textVisible = await textBtn.isVisible({ timeout: 2_000 }).catch(() => false);
    if (!textVisible) {
      throw new Error('LinkedIn: Easy Apply button is not visible on this page.');
    }
    log('[LinkedIn] Using text-fallback selector for Easy Apply button.');
    await textBtn.scrollIntoViewIfNeeded();
    await textBtn.click();
  } else {
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
  }

  // Wait for modal to open
  // [FRAGILE] selector: div[role="dialog"] is stable; .jobs-easy-apply-modal is not
  await page.waitForSelector(SEL.MODAL, { timeout: 12_000 });
  await page.waitForTimeout(800); // let modal settle / run entrance animations
  log('[LinkedIn] Easy Apply modal opened.');
}

/**
 * Read the step title from the modal's h2 or h3 heading.
 * Returns null if the title can't be determined.
 *
 * [FRAGILE] LinkedIn occasionally nests h2/h3 differently in different UI versions.
 * Fallback: read aria-label on the modal itself.
 */
async function getStepTitle(page) {
  return page.evaluate((modalSel) => {
    const modal = document.querySelector(modalSel);
    if (!modal) return null;
    const heading = modal.querySelector('h2, h3, h1');
    if (heading) return heading.textContent?.trim() ?? null;
    // aria-label fallback
    return modal.getAttribute('aria-label') ?? null;
  }, SEL.MODAL).catch(() => null);
}

/**
 * Click the "Next" (or "Review") button to advance the modal to the next step.
 * Returns true if a button was found and clicked, false if stuck.
 */
async function clickNextButton(page, log) {
  const candidates = [
    ...SEL.BTN_NEXT,
    ...SEL.BTN_REVIEW,
  ];

  for (const sel of candidates) {
    try {
      const btn = page.locator(sel).last(); // last() — footer typically has one button at the right
      const visible = await btn.isVisible({ timeout: 1_200 }).catch(() => false);
      if (!visible) continue;

      // Verify it's not disabled
      const disabled = await btn.isDisabled().catch(() => false);
      if (disabled) {
        log(`[LinkedIn] "${sel}" is disabled — skipping.`);
        continue;
      }

      log(`[LinkedIn] Clicking next: "${sel}"`);
      await btn.click();
      await page.waitForTimeout(1_200); // modal transition
      return true;
    } catch {
      // Try next candidate
    }
  }

  // Last-resort: find any non-disabled button in modal footer
  const footerBtn = await page.evaluate((modalSel) => {
    const modal = document.querySelector(modalSel);
    const footer = modal?.querySelector('footer, [class*="footer"]');
    if (!footer) return null;
    const btns = Array.from(footer.querySelectorAll('button')).filter(b => !b.disabled);
    // Rightmost (last) button is always the forward action
    const last = btns[btns.length - 1];
    return last?.textContent?.trim() ?? null;
  }, SEL.MODAL).catch(() => null);

  if (footerBtn) {
    log(`[LinkedIn] Last-resort next: clicking footer button "${footerBtn}"`);
    await page.locator(`${SEL.MODAL} footer button:last-of-type`).click().catch(() => {});
    await page.waitForTimeout(1_200);
    return true;
  }

  return false;
}

// ── Field-fill helpers (modal-scoped) ─────────────────────────────────────────

/**
 * Fill a text/number input inside the modal by matching label text.
 * Tries: label[for] ID → sibling input → container-scoped input.
 *
 * [FRAGILE] LinkedIn uses generated ember IDs. The label-for→input pattern
 * is the most reliable strategy. If that fails, try container-scoped querySelector.
 */
async function fillModalInput(page, labelText, value, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  if (!value) { skipped.push(`"${labelText}" — no value`); return false; }

  try {
    const inputId = await page.evaluate(({ modalSel, labelSearch }) => {
      const modal = document.querySelector(modalSel);
      if (!modal) return null;

      const labels = Array.from(modal.querySelectorAll('label, legend, span[class*="label"]'));
      const match  = labels.find(l => l.textContent?.toLowerCase().includes(labelSearch.toLowerCase()));
      if (!match) return null;

      // label[for] → input id
      if (match.htmlFor) return match.htmlFor;

      // Container scan
      const container = match.closest(
        '.fb-form-element, .jobs-easy-apply-form-element, .artdeco-text-input, [class*="form-element"]'
      ) ?? match.parentElement;
      const input = container?.querySelector('input:not([type="radio"]):not([type="checkbox"]), textarea');
      return input?.id ?? null;
    }, { modalSel: SEL.MODAL, labelSearch: labelText });

    if (!inputId) {
      skipped.push(`"${labelText}" input — label not found in modal`);
      return false;
    }

    const el = page.locator(`#${inputId}`);
    const visible = await el.isVisible({ timeout: 2_000 }).catch(() => false);
    if (!visible) {
      skipped.push(`"${labelText}" input — found label but input is not visible`);
      return false;
    }

    await el.scrollIntoViewIfNeeded();
    if (!dryRun) {
      await el.fill('');       // clear first
      await el.fill(value);
    }

    log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Filled modal "${labelText}": "${truncate(value, 60)}"`);
    filled.push({ label: labelText, value, selector: `#${inputId}` });
    return true;
  } catch (err) {
    warnings.push(`Modal "${labelText}" fill error: ${err.message}`);
    return false;
  }
}

/**
 * Select a native <select> dropdown inside the modal by label text.
 * Uses substring-match to find the best option.
 *
 * [FRAGILE] LinkedIn often replaces <select> with custom comboboxes in new UI versions.
 * If this fails, try fillModalCombobox() as a fallback.
 */
async function fillModalSelect(page, labelText, value, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  if (!value) { skipped.push(`"${labelText}" select — no value`); return false; }

  try {
    const selectId = await page.evaluate(({ modalSel, labelSearch }) => {
      const modal = document.querySelector(modalSel);
      if (!modal) return null;
      const labels = Array.from(modal.querySelectorAll('label'));
      const match  = labels.find(l => l.textContent?.toLowerCase().includes(labelSearch.toLowerCase()));
      if (!match) return null;
      if (match.htmlFor) {
        const el = document.getElementById(match.htmlFor);
        if (el?.tagName === 'SELECT') return el.id;
      }
      const container = match.closest('[class*="form-element"]') ?? match.parentElement;
      return container?.querySelector('select')?.id ?? null;
    }, { modalSel: SEL.MODAL, labelSearch: labelText });

    if (!selectId) {
      skipped.push(`"${labelText}" select — not found in modal`);
      return false;
    }

    const el = page.locator(`#${selectId}`);
    const options = await el.locator('option').allTextContents();
    const best =
      options.find(o => o.toLowerCase().includes(value.toLowerCase())) ??
      options.find(o => value.toLowerCase().includes(o.toLowerCase().trim()));

    if (!best) {
      warnings.push(`"${labelText}" select — no match for "${value}". Options: ${options.slice(0, 5).join(', ')}`);
      return false;
    }

    await el.scrollIntoViewIfNeeded();
    if (!dryRun) await el.selectOption({ label: best });

    log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Selected modal "${labelText}": "${best}"`);
    filled.push({ label: labelText, value: best, selector: `#${selectId}` });
    return true;
  } catch (err) {
    warnings.push(`Modal select "${labelText}" error: ${err.message}`);
    return false;
  }
}

/**
 * Interact with a LinkedIn custom combobox (role="combobox").
 * These replaced native <select> elements in LinkedIn's newer UI.
 *
 * Strategy: click → type → wait for listbox → click matching option.
 * [FRAGILE] The listbox appearance is async and timing-sensitive.
 */
async function fillModalCombobox(page, labelText, value, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  if (!value) { skipped.push(`"${labelText}" combobox — no value`); return false; }

  try {
    const comboId = await page.evaluate(({ modalSel, labelSearch }) => {
      const modal = document.querySelector(modalSel);
      if (!modal) return null;
      const labels = Array.from(modal.querySelectorAll('label'));
      const match  = labels.find(l => l.textContent?.toLowerCase().includes(labelSearch.toLowerCase()));
      if (!match) return null;
      const container = match.closest('[class*="form-element"]') ?? match.parentElement;
      const combo = container?.querySelector('[role="combobox"]');
      return combo?.id ?? null;
    }, { modalSel: SEL.MODAL, labelSearch: labelText });

    if (!comboId) {
      skipped.push(`"${labelText}" combobox — not found`);
      return false;
    }

    const el = page.locator(`#${comboId}`);
    await el.scrollIntoViewIfNeeded();

    if (!dryRun) {
      await el.click();
      await el.fill(value);

      // Wait for option list to appear
      // [FRAGILE] LinkedIn listboxes sometimes appear in a portal outside the modal DOM
      await page.waitForSelector(
        `[role="option"], [role="listbox"] [role="option"]`,
        { timeout: 3_000 }
      ).catch(() => {});

      const option = page.locator(`[role="option"]:has-text("${value}")`).first();
      const optVisible = await option.isVisible({ timeout: 2_000 }).catch(() => false);
      if (optVisible) {
        await option.click();
      } else {
        // Accept whatever is in the input
        await el.press('Enter');
      }
    }

    log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Combobox modal "${labelText}": "${value}"`);
    filled.push({ label: labelText, value, selector: `#${comboId}` });
    return true;
  } catch (err) {
    warnings.push(`Modal combobox "${labelText}" error: ${err.message}`);
    return false;
  }
}

/**
 * Select a radio button inside the modal by (legend text, option text) pair.
 * Works with both <fieldset>/<legend> groups and LinkedIn's custom radio groups.
 *
 * [FRAGILE] LinkedIn sometimes wraps radios in div[role="radiogroup"] with
 * a span as the label rather than <legend>. The page.evaluate fallback
 * handles both.
 */
async function fillModalRadio(page, legendText, valueText, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  if (!valueText) { skipped.push(`"${legendText}" radio — no value`); return false; }

  try {
    const radioId = await page.evaluate(({ modalSel, legend, value }) => {
      const modal = document.querySelector(modalSel);
      if (!modal) return null;

      // Find group by legend / aria-label / span label text
      const groups = Array.from(modal.querySelectorAll(
        'fieldset, [role="radiogroup"], [class*="radio-group"]'
      ));
      const group = groups.find(g => {
        const legendEl = g.querySelector('legend, [class*="label"], span[aria-hidden="false"]');
        return legendEl?.textContent?.toLowerCase().includes(legend.toLowerCase());
      });
      if (!group) return null;

      const radios = Array.from(group.querySelectorAll('input[type="radio"]'));
      for (const r of radios) {
        const labelEl = document.querySelector(`label[for="${r.id}"]`) ?? r.closest('label');
        const text    = (labelEl?.textContent ?? r.value ?? '').toLowerCase();
        if (text.includes(value.toLowerCase())) return r.id;
      }
      return null;
    }, { modalSel: SEL.MODAL, legend: legendText, value: valueText });

    if (!radioId) {
      skipped.push(`"${legendText}" radio — no option matching "${valueText}"`);
      return false;
    }

    const el = page.locator(`#${radioId}`);
    await el.scrollIntoViewIfNeeded();
    if (!dryRun) await el.check();

    log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Radio "${legendText}": "${valueText}"`);
    filled.push({ label: legendText, value: valueText, selector: `#${radioId}` });
    return true;
  } catch (err) {
    warnings.push(`Modal radio "${legendText}" error: ${err.message}`);
    return false;
  }
}

// ── Step handlers ─────────────────────────────────────────────────────────────

/**
 * Contact Info step.
 * LinkedIn pre-populates email from the account — do not attempt to change it.
 * Phone may or may not match profile — verify and correct if needed.
 */
async function handleContactInfoStep(page, fieldAnswers, ctx) {
  const { dryRun, log } = ctx;
  log('[LinkedIn] Step: Contact Info');

  // ── Phone ─────────────────────────────────────────────────────────────
  if (fieldAnswers.phone) {
    // [FRAGILE] id*="phoneNumber" works on current LinkedIn but may break.
    // [FALLBACK] fillModalInput by label text "Phone"
    const phoneEl = page.locator(SEL.PHONE_INPUT).first();
    const phoneVisible = await phoneEl.isVisible({ timeout: 3_000 }).catch(() => false);

    if (phoneVisible) {
      const current = await phoneEl.inputValue().catch(() => '');
      if (current !== fieldAnswers.phone) {
        await phoneEl.scrollIntoViewIfNeeded();
        if (!dryRun) {
          await phoneEl.fill('');
          await phoneEl.fill(fieldAnswers.phone);
        }
        log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Filled phone: "${fieldAnswers.phone}"`);
        ctx.filled.push({ label: 'Phone', value: fieldAnswers.phone, selector: SEL.PHONE_INPUT });
      } else {
        log('[LinkedIn] Phone already correct — skipping.');
      }
    } else {
      // Fallback: find by label
      await fillModalInput(page, 'Phone', fieldAnswers.phone, ctx);
    }
  }

  // ── Email ─────────────────────────────────────────────────────────────
  // Usually read-only. We verify but don't try to overwrite.
  const emailEl = page.locator('input[type="email"], input[id*="email"]').first();
  const emailVisible = await emailEl.isVisible({ timeout: 2_000 }).catch(() => false);
  if (emailVisible) {
    const emailVal = await emailEl.inputValue().catch(() => '');
    if (emailVal && emailVal !== fieldAnswers.email) {
      ctx.warnings.push(
        `LinkedIn email shows "${emailVal}" but profile has "${fieldAnswers.email}" — ` +
        `email field is read-only on LinkedIn and cannot be changed here.`
      );
    }
  }
}

/**
 * Resume step.
 * Prefers uploading the tailored PDF from output/ over LinkedIn's saved resume.
 * Uses setInputFiles() directly on the (possibly hidden) file input.
 */
async function handleResumeStep(page, fieldAnswers, ctx) {
  const { dryRun, log } = ctx;
  log('[LinkedIn] Step: Resume');

  if (!fieldAnswers.resumePath) {
    ctx.skipped.push('"Resume" — no tailored PDF in output/ directory. Run generate-pdf.mjs first.');
    return;
  }

  // Check if there's an existing saved resume (LinkedIn shows "Change resume")
  const hasUploadBtn = await page.locator(SEL.RESUME_UPLOAD_BTN).first().isVisible({ timeout: 2_000 }).catch(() => false);
  if (hasUploadBtn && !dryRun) {
    await page.locator(SEL.RESUME_UPLOAD_BTN).first().click().catch(() => {});
    await page.waitForTimeout(800);
  }

  // Find the (possibly hidden) file input
  // [FRAGILE] LinkedIn hides input[type="file"]. setInputFiles() works even when hidden.
  // [FALLBACK] If no input found, warn — user may need to upload manually.
  const fileInput = page.locator(SEL.RESUME_FILE_INPUT).first();
  const fileInputExists = await fileInput.count().then(n => n > 0).catch(() => false);

  if (!fileInputExists) {
    ctx.skipped.push('"Resume" — file input not found in modal (LinkedIn may have changed the upload UI)');
    return;
  }

  if (!dryRun) {
    await fileInput.setInputFiles(fieldAnswers.resumePath);
    // Give LinkedIn time to process the upload
    await page.waitForTimeout(2_000);
  }

  log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Uploaded resume: ${fieldAnswers.resumePath}`);
  ctx.filled.push({ label: 'Resume (PDF)', value: fieldAnswers.resumePath, selector: SEL.RESUME_FILE_INPUT });
}

/**
 * Additional Questions step (and generic fallback for unknown steps).
 *
 * Scans all visible form elements in the modal, matches against:
 *   1. fieldAnswers.customAnswers (from report Section H)
 *   2. Standard profile field mappings (work auth, salary, LinkedIn URL, etc.)
 *
 * Detects field type (input / textarea / select / combobox / radio) and
 * dispatches to the appropriate filler.
 *
 * [FRAGILE] LinkedIn's form element class names change with every major redesign.
 * The page.evaluate() approach reading label text is the most durable strategy.
 */
async function handleAdditionalQuestions(page, fieldAnswers, ctx) {
  const { log } = ctx;

  // Collect all labeled question elements from the modal
  const questions = await page.evaluate((modalSel) => {
    const modal = document.querySelector(modalSel);
    if (!modal) return [];

    const SKIP_LABELS = [
      'first name', 'last name', 'email address', 'phone', 'resume', 'curriculum',
      'city', 'country', 'mobile phone', 'phone number',
    ];

    const results = [];
    // [FRAGILE] Class names are the main fragility here. We enumerate several known patterns.
    const labelEls = Array.from(modal.querySelectorAll(
      '.fb-form-element label, ' +
      '.jobs-easy-apply-form-element label, ' +
      '.artdeco-text-input--label, ' +
      '[class*="form-element"] label, ' +
      'fieldset legend, ' +
      '[role="radiogroup"] > span:first-child'
    ));

    for (const labelEl of labelEls) {
      const text = labelEl.textContent?.trim().replace(/\s+/g, ' ').replace(/\s*\*$/, '') ?? '';
      if (!text || text.length < 2) continue;
      if (SKIP_LABELS.some(s => text.toLowerCase().includes(s))) continue;

      const forId = labelEl.htmlFor ?? null;
      const container = labelEl.closest(
        '.fb-form-element, .jobs-easy-apply-form-element, [class*="form-element"], fieldset'
      ) ?? labelEl.parentElement;

      // Determine field type
      let type = 'unknown';
      if (forId) {
        const target = document.getElementById(forId);
        if (target) {
          if (target.tagName === 'SELECT') type = 'select';
          else if (target.getAttribute('role') === 'combobox') type = 'combobox';
          else if (target.type === 'radio') type = 'radio';
          else if (target.tagName === 'TEXTAREA') type = 'textarea';
          else type = 'input';
        }
      } else if (container) {
        if (container.querySelectorAll('input[type="radio"]').length > 0)   type = 'radio';
        else if (container.querySelector('select'))                           type = 'select';
        else if (container.querySelector('[role="combobox"]'))               type = 'combobox';
        else if (container.querySelector('textarea'))                         type = 'textarea';
        else if (container.querySelector('input:not([type="hidden"])'))       type = 'input';
      }

      results.push({ text, forId, type });
    }

    // Deduplicate by text
    const seen = new Set();
    return results.filter(q => {
      if (seen.has(q.text)) return false;
      seen.add(q.text);
      return true;
    });
  }, SEL.MODAL).catch(() => []);

  const customAnswers = fieldAnswers.customAnswers ?? {};
  const customKeys    = Object.keys(customAnswers);

  for (const { text: labelText, type } of questions) {
    const lower = labelText.toLowerCase();

    // ── Find answer ──────────────────────────────────────────────────────
    let answer = null;

    // 1. Direct match against customAnswers (from report Section H)
    const matchKey = customKeys.find(k =>
      lower.includes(k.toLowerCase()) ||
      k.toLowerCase().includes(lower.replace(/\?$/, '').trim())
    );
    if (matchKey) answer = customAnswers[matchKey];

    // 2. Standard field mappings (order matters — more specific first)
    if (!answer) {
      if (/authorized.*(work|country)|work.*authorized|work.*legally/i.test(labelText)) {
        answer = 'Yes';  // work authorization radios are almost always Yes/No
      } else if (/require.*sponsor|sponsor.*require|need.*visa|visa.*require/i.test(labelText)) {
        answer = 'No';   // "Will you require sponsorship?" → No
      } else if (/salary|compensation|desired pay|expected pay|pay expectation/i.test(labelText)) {
        answer = fieldAnswers.salaryExpectation ?? '';
      } else if (/linkedin.*url|linkedin.*profile/i.test(labelText)) {
        answer = fieldAnswers.linkedin ?? '';
      } else if (/github/i.test(labelText)) {
        answer = fieldAnswers.github ?? '';
      } else if (/portfolio|personal.*site|website.*url/i.test(labelText)) {
        answer = fieldAnswers.portfolio ?? '';
      } else if (/cover letter/i.test(labelText)) {
        answer = fieldAnswers.coverLetter ?? '';
      } else if (/why.*(this role|role|position|apply)/i.test(labelText)) {
        answer = fieldAnswers.whyThisRole ?? fieldAnswers.coverLetter ?? '';
      } else if (/why.*(company|us|want to work)/i.test(labelText)) {
        answer = fieldAnswers.whyThisCompany ?? '';
      } else if (/years.*experience|experience.*years/i.test(labelText)) {
        answer = fieldAnswers.yearsExperience ?? '';
      } else if (/remote|hybrid|on.?site|work.*location/i.test(labelText)) {
        answer = fieldAnswers.remotePreference ?? '';
      }
    }

    if (!answer) {
      ctx.skipped.push(`"${labelText}" — no matching answer in customAnswers or profile`);
      continue;
    }

    // ── Dispatch to correct filler ───────────────────────────────────────
    switch (type) {
      case 'input':
      case 'textarea':
        await fillModalInput(page, labelText, answer, ctx);
        break;
      case 'select':
        // Try native select first, fall back to combobox
        if (!await fillModalSelect(page, labelText, answer, ctx)) {
          await fillModalCombobox(page, labelText, answer, ctx);
        }
        break;
      case 'combobox':
        await fillModalCombobox(page, labelText, answer, ctx);
        break;
      case 'radio':
        await fillModalRadio(page, labelText, answer, ctx);
        break;
      default:
        // Unknown — attempt generic input fill, warn if it fails
        if (!await fillModalInput(page, labelText, answer, ctx)) {
          ctx.skipped.push(`"${labelText}" — field type "${type}" unhandled`);
        }
    }
  }
}

// ── Screenshot helper ─────────────────────────────────────────────────────────

/**
 * Take a screenshot of the modal element only.
 * Scrolls within the modal if possible before capturing.
 */
async function screenshotModal(page, filePath) {
  try {
    const modalEl = page.locator(SEL.MODAL).first();
    const visible = await modalEl.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!visible) {
      // Fall back to full-page screenshot
      await page.screenshot({ path: filePath, fullPage: true });
    } else {
      await modalEl.screenshot({ path: filePath });
    }
    return filePath;
  } catch {
    return null;
  }
}

// ── Main adapter export ────────────────────────────────────────────────────────

/**
 * Fill a LinkedIn Easy Apply form.
 *
 * Orchestrates authentication, modal navigation, and field filling across
 * all modal steps. Returns a FilledForm result — never clicks Submit itself.
 * Stops at the Review step to allow human inspection.
 *
 * @param {import('playwright').Page} page
 * @param {object} fieldAnswers  Output of buildFieldAnswers() from field-mapper.mjs
 * @param {object} options
 * @param {boolean}  [options.dryRun=true]    If true, inspect/log without actually filling
 * @param {Function} [options.log]             Logger function
 * @param {string}   [options.company]         Company name (for reporting)
 * @param {string}   [options.role]            Role title (for reporting)
 * @returns {Promise<FilledForm>}
 */
export async function fillLinkedInForm(page, fieldAnswers, options = {}) {
  const {
    dryRun  = true,
    log     = console.log,
    company = fieldAnswers?._report?.company ?? 'Unknown',
    role    = fieldAnswers?._report?.role    ?? 'Unknown',
  } = options;

  const filled   = [];
  const skipped  = [];
  const warnings = [];
  const ctx      = { dryRun, log, filled, skipped, warnings };
  const prefix   = dryRun ? '[DRY RUN]' : '[LIVE]';

  log(`${prefix} LinkedIn Easy Apply — ${company} / ${role}`);

  // ── 0. Detect Easy Apply ───────────────────────────────────────────────
  const hasEasyApply = await detectEasyApply(page);
  if (!hasEasyApply) {
    log('[LinkedIn] No Easy Apply button — job uses external application. Skipping.');
    return {
      filled:   [],
      skipped:  ['All fields — LinkedIn Easy Apply not available on this job listing'],
      warnings: ['This listing uses an external application link. Apply manually.'],
      screenshotPath: null,
      ats:    'linkedin',
      jobUrl: page.url(),
      company,
      role,
      skip: true,   // non-standard field: signals orchestrator to skip LinkedIn adapter
    };
  }

  // ── 1. Authentication ──────────────────────────────────────────────────
  await ensureAuthenticated(page, log);

  // ── 2. Open modal ──────────────────────────────────────────────────────
  await openEasyApplyModal(page, log);

  // ── 3. Step-by-step modal navigation ──────────────────────────────────
  const visitedTitles = new Set();
  const MAX_STEPS     = 15;
  let screenshotPath  = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const title = await getStepTitle(page);
    log(`${prefix} Modal step ${step + 1}: "${title ?? '(unknown)'}"`);

    // ── Infinite-loop guard ──────────────────────────────────────────
    if (title && visitedTitles.has(title)) {
      warnings.push(`Step loop detected at "${title}" — breaking.`);
      break;
    }
    if (title) visitedTitles.add(title);

    const titleL = (title ?? '').toLowerCase();

    // ── Submit button visible? → we're at the final review/submit step ──
    const submitVisible = await page.locator(SEL.BTN_SUBMIT.join(', ')).first()
      .isVisible({ timeout: 1_000 }).catch(() => false);

    if (submitVisible || titleL.includes('review')) {
      log(`${prefix} Reached review/submit step.`);

      // Screenshot the modal before stopping
      const screenshotsDir = join(ROOT_DIR, 'data', 'screenshots');
      ensureDir(screenshotsDir);
      const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 28);
      const ts   = new Date().toISOString().slice(0, 10);
      const file = join(screenshotsDir, `linkedin-review-${slug(company)}-${slug(role)}-${ts}.png`);
      screenshotPath = await screenshotModal(page, file);
      if (screenshotPath) log(`${prefix} Review screenshot: ${screenshotPath}`);

      if (dryRun) {
        log(`${prefix} DRY RUN: stopping at review step. Inspect the modal above.`);
      } else {
        log(`${prefix} At submit step — call submitLinkedInForm() to complete.`);
      }
      break;
    }

    // ── Dispatch step handler ────────────────────────────────────────
    if (titleL.includes('contact')) {
      await handleContactInfoStep(page, fieldAnswers, ctx);
    } else if (titleL.includes('resume') || titleL.includes('cv')) {
      await handleResumeStep(page, fieldAnswers, ctx);
    } else if (
      titleL.includes('additional') ||
      titleL.includes('question') ||
      titleL.includes('screening') ||
      titleL.includes('qualification')
    ) {
      await handleAdditionalQuestions(page, fieldAnswers, ctx);
    } else if (
      titleL.includes('work experience') ||
      titleL.includes('education') ||
      titleL.includes('profile information') ||
      titleL.includes('voluntary')
    ) {
      // Usually pre-populated from LinkedIn profile.
      // Still scan for any empty required fields.
      log(`[LinkedIn] Step "${title}" — checking for required empty fields...`);
      await handleAdditionalQuestions(page, fieldAnswers, ctx);
    } else {
      // Unknown step — attempt generic fill, log for debugging
      log(`[LinkedIn] Unknown step "${title}" — attempting generic field scan.`);
      await handleAdditionalQuestions(page, fieldAnswers, ctx);
    }

    // ── Advance to next step ─────────────────────────────────────────
    const advanced = await clickNextButton(page, log);
    if (!advanced) {
      warnings.push(`Could not advance past step "${title}" — no Next/Review button found.`);
      break;
    }
  }

  // ── 4. Save session ────────────────────────────────────────────────────
  await saveSession(page);

  log(`\n${prefix} LinkedIn form fill complete.`);
  log(`  Fields filled:  ${filled.length}`);
  log(`  Fields skipped: ${skipped.length}`);
  log(`  Warnings:       ${warnings.length}`);

  return {
    filled,
    skipped,
    warnings,
    screenshotPath,   // review screenshot if captured; null otherwise
    ats:    'linkedin',
    jobUrl: page.url(),
    company,
    role,
  };
}

/**
 * Submit the LinkedIn Easy Apply form.
 * Only called from index.mjs after human confirmation.
 *
 * The form should already be at the Review / Submit step (fillLinkedInForm
 * stops there). We find and click "Submit application", then detect
 * LinkedIn's confirmation toast.
 *
 * @param {import('playwright').Page} page
 * @param {Function} [log]
 * @returns {Promise<{ success: boolean, confirmationUrl: string|null, message: string }>}
 */
export async function submitLinkedInForm(page, log = console.log) {
  try {
    // Find the submit button — try all known selectors
    let submitBtn = null;
    for (const sel of SEL.BTN_SUBMIT) {
      const btn = page.locator(sel).first();
      const visible = await btn.isVisible({ timeout: 2_000 }).catch(() => false);
      if (visible) {
        submitBtn = btn;
        break;
      }
    }

    if (!submitBtn) {
      return {
        success: false,
        confirmationUrl: null,
        message: 'LinkedIn: "Submit application" button not found — may not be at review step.',
      };
    }

    log('[LIVE] Clicking "Submit application"...');
    await submitBtn.scrollIntoViewIfNeeded();
    await submitBtn.click();

    // ── Wait for confirmation ──────────────────────────────────────────
    // [FRAGILE] Toast selectors change frequently.
    // [FALLBACK] Body text check catches any wording variant.
    let confirmed = false;
    try {
      await Promise.race([
        page.waitForSelector(SEL.CONFIRMATION, { timeout: 15_000 }),
        page.waitForFunction(
          () =>
            document.body.textContent.toLowerCase().includes('application was sent') ||
            document.body.textContent.toLowerCase().includes('application submitted') ||
            document.body.textContent.toLowerCase().includes('your application'),
          { timeout: 15_000 }
        ),
      ]);
      confirmed = true;
    } catch {
      // Manual fallback check
      confirmed = await page.evaluate(() => {
        const t = document.body.textContent.toLowerCase();
        return (
          t.includes('application was sent') ||
          t.includes('application submitted') ||
          t.includes('your application')
        );
      }).catch(() => false);
    }

    if (!confirmed) {
      return {
        success: false,
        confirmationUrl: page.url(),
        message: 'LinkedIn: No confirmation detected after clicking Submit. Verify manually.',
      };
    }

    // Read confirmation message text
    const confirmationText = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el?.textContent?.trim() ?? 'Application submitted';
    }, SEL.CONFIRMATION).catch(() => 'Application submitted');

    // Save updated session
    await saveSession(page);

    log(`[LIVE] LinkedIn submission confirmed: "${confirmationText}"`);
    return {
      success: true,
      confirmationUrl: page.url(),
      message: confirmationText,
    };
  } catch (err) {
    return {
      success: false,
      confirmationUrl: null,
      message: `LinkedIn submitLinkedInForm error: ${err.message}`,
    };
  }
}

// ── Adapter interface aliases ──────────────────────────────────────────────────
// Simplified exports as specified in the adapter interface contract.
// fillForm(page, answers, dryRun) — dryRun is a positional boolean here.

/**
 * @param {import('playwright').Page} page
 * @param {object}  answers  FieldAnswers from buildFieldAnswers()
 * @param {boolean} [dryRun=true]
 */
export async function fillForm(page, answers, dryRun = true) {
  return fillLinkedInForm(page, answers, { dryRun });
}

/**
 * @param {import('playwright').Page} page
 */
export async function submitForm(page) {
  return submitLinkedInForm(page);
}
