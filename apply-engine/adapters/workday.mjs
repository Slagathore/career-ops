/**
 * apply-engine/adapters/workday.mjs
 *
 * Playwright adapter for Workday ATS application forms.
 *
 * Workday is the hardest ATS to automate. Key challenges:
 *   - Full Angular SPA with generated IDs (e.g. "input-4") that change between sessions
 *   - Multi-step form navigation (My Information → My Experience → Application Questions
 *     → Voluntary Disclosures → Review and Submit)
 *   - Custom web components that reject Playwright's fill() — must use keyboard.type()
 *   - Custom combobox/popover dropdowns (not native <select>)
 *   - Bot detection that blocks headless Chromium
 *   - Optional CAPTCHA on entry
 *   - Login-or-guest choice before reaching the form
 *
 * Detection: URLs match *.myworkdayjobs.com or page embeds Workday via iframe.
 *
 * Usage:
 *   import { fillForm, submitForm, isWorkdayPage } from './adapters/workday.mjs';
 *   const result = await fillForm(page, fieldAnswers, { dryRun: true, log, company, role });
 */

import { existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// ── Path helpers ──────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
// adapters/ is two levels below project root: career-ops/apply-engine/adapters/
const ROOT_DIR    = resolve(__dirname, '..', '..');
const DATA_DIR    = join(ROOT_DIR, 'data');
const SESSION_FILE = join(DATA_DIR, '.workday-session.json');

// ── Workday selector constants ────────────────────────────────────────────────
//
// Workday's Angular app uses two reliable attributes across all tenants:
//   data-automation-id  — Workday's own QA infrastructure labels; stable across sessions
//   aria-label          — set consistently by Workday's component library
//
// NEVER rely on generated IDs like "input-4" — they change per session.

const WD = {
  // ── Authentication / entry ─────────────────────────────────────────────
  APPLY_BUTTON:   '[data-automation-id="applyButton"]',
  // Guest / "Apply Manually" link — Workday's own automation ID in some tenants,
  // plus common text variants across tenant configurations.
  APPLY_MANUALLY: [
    '[data-automation-id="applyManually"]',
    'a:has-text("Apply Manually")',
    'a:has-text("Continue as Guest")',
    'a:has-text("Apply as Guest")',
    '[data-automation-id="createAccountLink"]',  // sometimes labelled differently
  ].join(', '),
  SIGN_IN_WITH_WORKDAY: '[data-automation-id="signInWithWorkdayAccount"]',

  // ── Step / breadcrumb detection ────────────────────────────────────────
  CURRENT_STEP:   '[data-automation-id="currentStep"]',
  STEP_BREADCRUMB:'[data-automation-id="stepsBreadcrumbs"]',

  // ── Navigation buttons ─────────────────────────────────────────────────
  NEXT_BUTTON:    '[data-automation-id="bottom-navigation-next-button"]',
  SAVE_CONTINUE:  '[data-automation-id="bottom-navigation-save-continue-button"]',
  SUBMIT_BUTTON:  '[data-automation-id="bottom-navigation-submit-button"]',

  // ── Contact / personal info (data-automation-id) ───────────────────────
  FIRST_NAME:     '[data-automation-id="legalNameSection_firstName"]',
  LAST_NAME:      '[data-automation-id="legalNameSection_lastName"]',
  // Email field — Workday uses several possible ids depending on tenant version
  EMAIL:          '[data-automation-id="email"]',
  PHONE:          '[data-automation-id="phone-number"]',
  PHONE_TYPE:     '[data-automation-id="phone-device-type"]',
  ADDRESS_LINE1:  '[data-automation-id="addressSection_addressLine1"]',
  CITY:           '[data-automation-id="addressSection_city"]',
  POSTAL_CODE:    '[data-automation-id="addressSection_postalCode"]',

  // ── Resume / file upload ───────────────────────────────────────────────
  // Workday's drop zone has a hidden <input type="file"> we can target directly.
  // The data-automation-id varies slightly by tenant.
  RESUME_INPUT:   '[data-automation-id="file-upload-input-ref"]',
  RESUME_INPUT_2: 'input[data-automation-id*="upload"][type="file"]',
  FILE_INPUT_ANY: 'input[type="file"]',

  // ── Dropdowns / comboboxes ─────────────────────────────────────────────
  COMBOBOX:       '[role="combobox"]',
  // Workday popover options — the list items rendered in the dropdown overlay
  PROMPT_OPTION:  '[data-automation-id="promptOption"]',

  // ── Confirmation / success ─────────────────────────────────────────────
  CONFIRMATION:            '[data-automation-id="applicationConfirmation"]',
  SUCCESS_NOTIFICATION:    '[data-automation-id="successNotificationDialog"]',

  // ── CAPTCHA ────────────────────────────────────────────────────────────
  CAPTCHA: '[data-automation-id="captcha"], iframe[src*="recaptcha"], iframe[src*="captcha"], .g-recaptcha',
};

// ── Human-like timing helpers ─────────────────────────────────────────────────

/**
 * Random delay between min and max ms.
 * Workday's bot detection watches for robotic-speed interactions — always pace
 * between field interactions even in live mode.
 *
 * @param {import('playwright').Page} page
 * @param {number} [min=200]
 * @param {number} [max=700]
 */
async function humanDelay(page, min = 200, max = 700) {
  const ms = Math.floor(Math.random() * (max - min) + min);
  await page.waitForTimeout(ms);
}

/**
 * Occasionally move the mouse to a random screen position.
 * Simulates natural user behavior; called between steps.
 * Only fires ~30% of the time so it doesn't slow things down too much.
 *
 * @param {import('playwright').Page} page
 */
async function randomMouseMove(page) {
  if (Math.random() < 0.3) {
    const x = Math.floor(Math.random() * 800 + 200);
    const y = Math.floor(Math.random() * 400 + 100);
    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 5 + 3) }).catch(() => {});
  }
}

// ── Workday detection ─────────────────────────────────────────────────────────

/**
 * Returns true if the current page is (or embeds) a Workday application form.
 * Checks URL, iframe sources, and Workday-specific DOM markers.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function isWorkdayPage(page) {
  const url = page.url().toLowerCase();

  // Direct Workday-hosted URL (all subdomains: wd1, wd3, wd5, etc.)
  if (url.includes('myworkdayjobs.com')) return true;

  // Embedded via iframe or script on a company career page
  const hasWorkdayMarker = await page.evaluate(() => {
    // Workday scripts served from *.workday.com or *.myworkdayjobs.com
    const scripts = Array.from(document.querySelectorAll('script[src]'));
    if (scripts.some(s => s.src.includes('workday') || s.src.includes('myworkdayjobs'))) return true;

    // Workday's Angular components tag everything with data-automation-id
    // If there's a Workday form embedded, these will be present
    if (document.querySelector('[data-automation-id="legalNameSection_firstName"]')) return true;
    if (document.querySelector('[data-automation-id="applyButton"]')) return true;

    // Workday iframe embed
    const iframes = Array.from(document.querySelectorAll('iframe[src]'));
    if (iframes.some(f => f.src.includes('myworkdayjobs.com') || f.src.includes('workday.com'))) return true;

    return false;
  }).catch(() => false);

  return hasWorkdayMarker;
}

// ── Session persistence ───────────────────────────────────────────────────────

/**
 * Save browser context storage state to disk.
 * On the next run, pass { storageState: SESSION_FILE } to browser.newContext()
 * to skip any Workday account login steps.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {Function} log
 */
async function saveSession(context, log) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    await context.storageState({ path: SESSION_FILE });
    log(`[WORKDAY] Session state saved → ${SESSION_FILE}`);
    log(`[WORKDAY]   Load on next run: browser.newContext({ storageState: '${SESSION_FILE}' })`);
  } catch (err) {
    log(`[WORKDAY] Warning: Could not save session state: ${err.message}`);
  }
}

/**
 * Returns true if a saved Workday session file exists on disk.
 * The caller can pass it as storageState to skip login on repeat runs.
 *
 * @returns {boolean}
 */
export function hasSavedSession() {
  return existsSync(SESSION_FILE);
}

// ── CAPTCHA detection ─────────────────────────────────────────────────────────

/**
 * Returns true if any CAPTCHA element is detected on the current page.
 * Covers Workday's own CAPTCHA wrapper AND standard reCAPTCHA iframes.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function detectCaptcha(page) {
  return page.evaluate(() => {
    return !!(
      document.querySelector('[data-automation-id="captcha"]') ||
      document.querySelector('iframe[src*="recaptcha"]') ||
      document.querySelector('iframe[src*="captcha"]') ||
      document.querySelector('.g-recaptcha') ||
      document.querySelector('[id*="recaptcha"]')
    );
  }).catch(() => false);
}

// ── Authentication / guest flow ───────────────────────────────────────────────

/**
 * Navigate from the Workday job listing page to the actual application form.
 *
 * Workday shows two options after clicking Apply:
 *   • "Apply with Workday" — requires a Workday account (sign in)
 *   • "Apply Manually" / "Continue as Guest" — no account required
 *
 * We always prefer guest mode (faster, no account needed).
 * If guest is unavailable, we pause and wait for the user to log in manually.
 *
 * @param {import('playwright').Page} page
 * @param {Function} log
 * @returns {Promise<boolean>} true if we successfully reached the form
 */
async function navigateToApplicationForm(page, log) {
  log('[WORKDAY] Checking for application form...');

  // If already on the form (e.g. direct /apply URL), nothing to do
  const alreadyOnForm = await page.locator(
    `${WD.FIRST_NAME}, [data-automation-id="applicationFlow"], [data-automation-id="emailAddress"]`
  ).isVisible({ timeout: 3000 }).catch(() => false);

  if (alreadyOnForm) {
    log('[WORKDAY] Already on application form — skipping navigation.');
    return true;
  }

  // Wait for the initial page to fully settle (Workday SPA can take a moment)
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await humanDelay(page, 500, 1000);

  // Look for the main Apply button
  const applyBtn = page.locator(WD.APPLY_BUTTON).first();
  const applyVisible = await applyBtn.isVisible({ timeout: 6000 }).catch(() => false);

  if (applyVisible) {
    log('[WORKDAY] Clicking main Apply button...');
    await applyBtn.scrollIntoViewIfNeeded().catch(() => {});
    await applyBtn.click();
    await humanDelay(page, 800, 1500);
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
  } else {
    // Fallback: text-based Apply button (some Workday tenants render it differently)
    const applyFallback = page.locator(
      'button:has-text("Apply"), a:has-text("Apply for this job"), a:has-text("Apply Now")'
    ).first();
    const fbVisible = await applyFallback.isVisible({ timeout: 3000 }).catch(() => false);
    if (fbVisible) {
      log('[WORKDAY] Clicking Apply button (text match fallback)...');
      await applyFallback.click();
      await humanDelay(page, 800, 1500);
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    } else {
      log('[WORKDAY] Warning: No Apply button found — may already be on form, or URL is wrong.');
    }
  }

  // Check whether a login dialog appeared
  const loginDialogVisible = await page.locator(WD.SIGN_IN_WITH_WORKDAY).isVisible({ timeout: 4000 }).catch(() => false);

  if (loginDialogVisible) {
    log('[WORKDAY] Login dialog appeared. Looking for guest / manual apply option...');

    // Try to find the guest link
    const guestLink = page.locator(WD.APPLY_MANUALLY).first();
    const guestVisible = await guestLink.isVisible({ timeout: 5000 }).catch(() => false);

    if (guestVisible) {
      log('[WORKDAY] Selecting "Apply Manually" (guest application)...');
      await guestLink.click();
      await humanDelay(page, 600, 1200);
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    } else {
      // No guest option — this company requires a Workday account.
      // Pause and wait for the user to log in manually, then navigate to apply.
      log('[WORKDAY] ⚠️  Guest application not available for this company.');
      log('[WORKDAY]    Please log in to Workday in the browser window.');
      log('[WORKDAY]    Automation will resume once you reach the /apply step.');
      log('[WORKDAY]    Waiting up to 3 minutes...');

      try {
        await page.waitForURL('**apply**', { timeout: 180_000 });
        log('[WORKDAY] Login detected — resuming automation.');
      } catch {
        log('[WORKDAY] Warning: Login wait timed out. Attempting to continue anyway.');
      }
    }
  }

  // Final form-presence check
  await humanDelay(page, 400, 800);
  const formReady = await page.locator(
    `${WD.FIRST_NAME}, [data-automation-id="emailAddress"], [data-automation-id="applicationFlow"]`
  ).isVisible({ timeout: 12_000 }).catch(() => false);

  if (formReady) {
    log('[WORKDAY] Application form loaded successfully.');
  } else {
    log('[WORKDAY] Warning: Could not confirm form is loaded. Proceeding anyway.');
  }

  return formReady;
}

// ── Step detection ────────────────────────────────────────────────────────────

/**
 * Get the current Workday step name from breadcrumb or active step indicator.
 * Returns strings like "My Information", "My Experience", "Application Questions", etc.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function getCurrentStep(page) {
  // Strategy 1: [data-automation-id="currentStep"] text
  const stepEl = page.locator(WD.CURRENT_STEP).first();
  const stepText = await stepEl.textContent({ timeout: 2000 }).catch(() => null);
  if (stepText?.trim()) return stepText.trim();

  // Strategy 2: active breadcrumb item
  const activeCrumb = page.locator(
    `${WD.STEP_BREADCRUMB} [aria-current="step"], ${WD.STEP_BREADCRUMB} [class*="active"]`
  ).first();
  const crumbText = await activeCrumb.textContent({ timeout: 2000 }).catch(() => null);
  if (crumbText?.trim()) return crumbText.trim();

  // Strategy 3: first visible h2 or h3 (Workday puts the step name in a heading)
  const heading = page.locator('h2, h3').first();
  const headingText = await heading.textContent({ timeout: 2000 }).catch(() => null);
  if (headingText?.trim()) return headingText.trim();

  return 'Unknown';
}

// ── Low-level field fill helpers ──────────────────────────────────────────────

/**
 * Type a value into a Workday custom input field.
 *
 * Workday's Angular web components frequently ignore Playwright's fill().
 * Reliable approach:
 *   1. Click the field to focus it
 *   2. Select-all + Delete to clear any existing value
 *   3. page.keyboard.type() with a small per-character delay (human-like)
 *
 * @param {import('playwright').Page} page
 * @param {string} selector  CSS selector for the input
 * @param {string} value     Value to type
 * @param {string} label     Human-readable label for logging
 * @param {object} ctx       { dryRun, log, filled, skipped, warnings }
 * @returns {Promise<boolean>}
 */
async function wdTypeField(page, selector, value, label, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;

  if (!value) {
    skipped.push(`"${label}" — no value in profile/report`);
    return false;
  }

  try {
    const el = page.locator(selector).first();
    const visible = await el.isVisible({ timeout: 5000 }).catch(() => false);

    if (!visible) {
      skipped.push(`"${label}" — field not found (${selector})`);
      return false;
    }

    await el.scrollIntoViewIfNeeded().catch(() => {});
    await humanDelay(page, 150, 350);

    if (!dryRun) {
      await el.click();
      await humanDelay(page, 100, 200);

      // Select all and clear — fill() is unreliable on Workday's custom components
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await humanDelay(page, 50, 120);

      // Type with a randomised per-character delay (20–50ms) to mimic human speed
      await page.keyboard.type(value, { delay: Math.floor(Math.random() * 30 + 20) });
    }

    await randomMouseMove(page);

    log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} [WORKDAY] Typed "${label}": "${truncate(value, 60)}"`);
    filled.push({ label, value, selector });
    return true;
  } catch (err) {
    warnings.push(`[WORKDAY] "${label}" type failed: ${err.message}`);
    return false;
  }
}

/**
 * Try a list of selectors in order, calling wdTypeField on the first visible one.
 * Use this for fields where the data-automation-id varies across Workday tenants.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} selectors  Ordered list of selectors to try
 * @param {string}   value
 * @param {string}   label
 * @param {object}   ctx
 * @returns {Promise<boolean>}
 */
async function wdFindAndFill(page, selectors, value, label, ctx) {
  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        return wdTypeField(page, selector, value, label, ctx);
      }
    } catch {
      // This selector failed — try the next
    }
  }

  // Nothing found
  ctx.skipped.push(`"${label}" — no matching field found (tried ${selectors.length} selectors)`);
  return false;
}

/**
 * Handle a Workday custom dropdown / combobox.
 *
 * Workday dropdowns are Angular overlay components, NOT native <select>s.
 * Interaction pattern:
 *   1. Click the trigger to open the popover
 *   2. Type to filter options
 *   3. Wait for [data-automation-id="promptOption"] list items
 *   4. Click the best-matching option
 *
 * @param {import('playwright').Page} page
 * @param {string} triggerSelector  CSS selector for the dropdown trigger
 * @param {string} searchValue      Text to match against (also typed to filter)
 * @param {string} label            Human-readable label for logging
 * @param {object} ctx              { dryRun, log, filled, skipped, warnings }
 * @returns {Promise<boolean>}
 */
async function wdSelectDropdown(page, triggerSelector, searchValue, label, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;

  if (!searchValue) {
    skipped.push(`"${label}" dropdown — no value to select`);
    return false;
  }

  try {
    const trigger = page.locator(triggerSelector).first();
    const visible = await trigger.isVisible({ timeout: 5000 }).catch(() => false);

    if (!visible) {
      skipped.push(`"${label}" dropdown — trigger not found (${triggerSelector})`);
      return false;
    }

    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await humanDelay(page, 200, 500);

    if (!dryRun) {
      await trigger.click();
      await humanDelay(page, 300, 700);

      // Type the first ~12 chars to filter — don't need the full string
      await page.keyboard.type(searchValue.substring(0, 12), { delay: 50 });
      await humanDelay(page, 500, 900);

      // Wait for the option list to render
      await page.waitForSelector(WD.PROMPT_OPTION, { timeout: 5000 }).catch(() => {});

      // Pick the best-matching option
      const options = await page.locator(WD.PROMPT_OPTION).all();
      let matched = false;

      for (const opt of options) {
        const text = await opt.textContent().catch(() => '');
        const tLower = text.toLowerCase().trim();
        const vLower = searchValue.toLowerCase();
        if (tLower.includes(vLower) || vLower.includes(tLower)) {
          await opt.click();
          matched = true;
          log(`[LIVE] [WORKDAY] Selected "${label}": "${text.trim()}"`);
          break;
        }
      }

      if (!matched) {
        if (options.length > 0) {
          // First option as fallback — better than nothing
          const firstText = await options[0].textContent().catch(() => '?');
          await options[0].click();
          warnings.push(`[WORKDAY] "${label}" dropdown — no exact match for "${searchValue}"; selected first option: "${firstText.trim()}"`);
          matched = true;
        } else {
          // Close the dropdown without selecting
          await page.keyboard.press('Escape').catch(() => {});
          skipped.push(`"${label}" dropdown — no options appeared for "${searchValue}"`);
          return false;
        }
      }

      await humanDelay(page, 200, 400);
    } else {
      log(`[DRY RUN] [WORKDAY] Would select "${label}": "${searchValue}"`);
    }

    filled.push({ label, value: searchValue, selector: triggerSelector });
    return true;
  } catch (err) {
    warnings.push(`[WORKDAY] "${label}" dropdown — ${err.message}`);
    return false;
  }
}

/**
 * Upload resume via Workday's file upload component.
 *
 * Workday renders a styled drop zone (div) over a hidden <input type="file">.
 * We target the hidden input directly with setInputFiles() — this bypasses the
 * styled button entirely and avoids any OS file-picker interaction.
 *
 * Selector hierarchy:
 *   1. [data-automation-id="file-upload-input-ref"]  (most Workday tenants)
 *   2. input[data-automation-id*="upload"][type="file"]  (variant)
 *   3. input[type="file"]  (any file input as last resort)
 *
 * @param {import('playwright').Page} page
 * @param {string|null} resumePath  Absolute path to the PDF
 * @param {object} ctx
 * @returns {Promise<boolean>}
 */
async function wdUploadResume(page, resumePath, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;

  if (!resumePath) {
    skipped.push('"Resume" — no PDF found in output/ directory');
    return false;
  }

  // Try selectors in priority order
  const uploadSelectors = [
    WD.RESUME_INPUT,
    WD.RESUME_INPUT_2,
    WD.FILE_INPUT_ANY,
  ];

  for (const selector of uploadSelectors) {
    try {
      const inputs = page.locator(selector);
      const count  = await inputs.count().catch(() => 0);

      if (count === 0) continue;

      const input = inputs.first();

      // setInputFiles works on hidden file inputs — no click needed
      if (!dryRun) await input.setInputFiles(resumePath);

      const label = `Resume (PDF) [${selector}]`;
      log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} [WORKDAY] Uploaded resume: ${resumePath}`);
      filled.push({ label: 'Resume (PDF)', value: resumePath, selector });

      // Brief pause after upload — Workday processes the file asynchronously
      if (!dryRun) await humanDelay(page, 800, 1500);

      return true;
    } catch (err) {
      // This selector failed — try the next
      warnings.push(`[WORKDAY] Resume upload attempt with "${selector}" failed: ${err.message}`);
    }
  }

  skipped.push('"Resume" — all file input selectors failed (see warnings for details)');
  return false;
}

/**
 * Find a question's associated textarea/input by its label text, then type the answer.
 *
 * Used for employer-configured custom questions on the Application Questions step.
 * Workday renders these with a <label> and an associated input/textarea — sometimes
 * connected via htmlFor, sometimes via DOM proximity inside a wrapper component.
 *
 * @param {import('playwright').Page} page
 * @param {string} labelText  Text content of the question label
 * @param {string} value      Answer to type
 * @param {object} ctx
 * @returns {Promise<boolean>}
 */
async function wdFillCustomQuestion(page, labelText, value, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;

  if (!value) {
    skipped.push(`"${labelText}" — no matching answer in report Section H`);
    return false;
  }

  try {
    // Evaluate in-page to find the associated input element ID
    const foundSelector = await page.evaluate((searchText) => {
      const labels = Array.from(document.querySelectorAll('label'));
      const match  = labels.find(l =>
        l.textContent.trim().toLowerCase().includes(searchText.toLowerCase())
      );
      if (!match) return null;

      // Try htmlFor first (explicit association)
      if (match.htmlFor) {
        const el = document.getElementById(match.htmlFor);
        if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
          return el.id ? `#${CSS.escape(el.id)}` : null;
        }
      }

      // Walk up to a Workday wrapper component, then find the input inside it
      const container = match.closest('[data-automation-id], .field, .form-group, section')
        ?? match.parentElement;
      if (!container) return null;

      const input = container.querySelector('textarea, input[type="text"], input[type="number"]');
      if (input) {
        return input.id ? `#${CSS.escape(input.id)}` : null;
      }

      return null;
    }, labelText);

    if (foundSelector) {
      return wdTypeField(page, foundSelector, value, labelText, ctx);
    }

    // Fallback: aria-label contains the question text
    const ariaSelector = `[aria-label*="${labelText.slice(0, 40)}"]`;
    const ariaEl = page.locator(ariaSelector).first();
    const ariaVisible = await ariaEl.isVisible({ timeout: 2000 }).catch(() => false);
    if (ariaVisible) {
      return wdTypeField(page, ariaSelector, value, labelText, ctx);
    }

    skipped.push(`"${labelText}" — label matched but no associated input found`);
    return false;
  } catch (err) {
    warnings.push(`[WORKDAY] Custom question "${truncate(labelText, 50)}" — ${err.message}`);
    return false;
  }
}

// ── Multi-step navigation ─────────────────────────────────────────────────────

/**
 * Click the Next / Save and Continue button to advance to the next step.
 * Waits for DOM to settle before returning.
 *
 * @param {import('playwright').Page} page
 * @param {Function} log
 * @returns {Promise<boolean>} true if a button was found and clicked
 */
async function clickNext(page, log) {
  await humanDelay(page, 300, 600);

  const candidates = [
    { sel: WD.NEXT_BUTTON,   label: 'Next' },
    { sel: WD.SAVE_CONTINUE, label: 'Save and Continue' },
    { sel: 'button:has-text("Next")',               label: 'Next (text)' },
    { sel: 'button:has-text("Save and Continue")',   label: 'Save and Continue (text)' },
    { sel: 'button:has-text("Continue")',            label: 'Continue (text)' },
  ];

  for (const { sel, label } of candidates) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) {
      log(`[WORKDAY] Clicking "${label}" button...`);
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click();
      await humanDelay(page, 600, 1200);
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
      await humanDelay(page, 300, 600);
      return true;
    }
  }

  log('[WORKDAY] Warning: No Next/Continue button found — step navigation may be stalled.');
  return false;
}

/**
 * Returns true if the current step appears to be the Review / Submit step.
 * We stop filling here and let the user (or submitForm()) handle the final click.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function isOnReviewStep(page) {
  const step = (await getCurrentStep(page)).toLowerCase();
  return (
    step.includes('review') ||
    step.includes('submit') ||
    step.includes('confirm') ||
    step.includes('summary')
  );
}

// ── Per-step fill handlers ────────────────────────────────────────────────────

/**
 * Fill the "My Information" step — personal contact details.
 *
 * Workday's My Information step collects:
 *   First Name, Last Name, Email, Phone (+ device type), optional Address
 *
 * @param {import('playwright').Page} page
 * @param {object} fieldAnswers  Output of buildFieldAnswers()
 * @param {object} ctx
 */
async function fillMyInformation(page, fieldAnswers, ctx) {
  const { log } = ctx;
  log('[WORKDAY] Filling "My Information" step...');

  // First Name — try data-automation-id first, then aria-label variants
  await wdFindAndFill(page, [
    WD.FIRST_NAME,
    '[data-automation-id="firstName"]',
    '[aria-label="First Name"]',
    '[aria-label="First name"]',
    'input[aria-label*="First"]',
  ], fieldAnswers.firstName, 'First Name', ctx);

  await humanDelay(page, 200, 450);

  // Last Name
  await wdFindAndFill(page, [
    WD.LAST_NAME,
    '[data-automation-id="lastName"]',
    '[aria-label="Last Name"]',
    '[aria-label="Last name"]',
    'input[aria-label*="Last"]',
  ], fieldAnswers.lastName, 'Last Name', ctx);

  await humanDelay(page, 200, 450);

  // Email — Workday uses several automation IDs across tenant versions
  await wdFindAndFill(page, [
    WD.EMAIL,
    '[data-automation-id="emailAddress"]',
    '[aria-label="Email Address"]',
    '[aria-label="Email"]',
    'input[type="email"]',
  ], fieldAnswers.email, 'Email', ctx);

  await humanDelay(page, 200, 450);

  // Phone number
  if (fieldAnswers.phone) {
    await wdFindAndFill(page, [
      WD.PHONE,
      '[data-automation-id="phoneNumber"]',
      '[data-automation-id="phoneDevice"]',
      '[aria-label="Phone Number"]',
      '[aria-label="Phone"]',
      'input[type="tel"]',
    ], fieldAnswers.phone, 'Phone', ctx);

    await humanDelay(page, 200, 400);

    // Phone device type (Mobile / Home / Work) — non-critical, skip quietly if missing
    const phoneTypeVisible = await page.locator(WD.PHONE_TYPE).isVisible({ timeout: 2000 }).catch(() => false);
    if (phoneTypeVisible) {
      await wdSelectDropdown(page, WD.PHONE_TYPE, 'Mobile', 'Phone Device Type', ctx).catch(() => {
        ctx.skipped.push('"Phone Device Type" dropdown — could not open');
      });
    }
  }

  await humanDelay(page, 300, 600);

  // Address fields — only present on some Workday tenants; pull from profile if available
  const candidate = fieldAnswers._profile?.candidate ?? {};
  if (candidate.address_line1) {
    await wdFindAndFill(page, [
      WD.ADDRESS_LINE1,
      '[aria-label="Address Line 1"]',
    ], candidate.address_line1, 'Address Line 1', ctx);
    await humanDelay(page, 150, 300);
  }
  if (candidate.city) {
    await wdFindAndFill(page, [
      WD.CITY,
      '[aria-label="City"]',
    ], candidate.city, 'City', ctx);
    await humanDelay(page, 150, 300);
  }
  if (candidate.postal_code) {
    await wdFindAndFill(page, [
      WD.POSTAL_CODE,
      '[aria-label="Postal Code"]',
      '[aria-label="Zip Code"]',
    ], candidate.postal_code, 'Postal Code', ctx);
  }

  await randomMouseMove(page);
  log('[WORKDAY] "My Information" step complete.');
}

/**
 * Fill the "My Experience" step — resume upload, LinkedIn, portfolio.
 *
 * The primary action here is uploading the resume PDF.
 * Some Workday tenants also ask for LinkedIn and portfolio URLs on this step.
 *
 * @param {import('playwright').Page} page
 * @param {object} fieldAnswers
 * @param {object} ctx
 */
async function fillMyExperience(page, fieldAnswers, ctx) {
  const { log } = ctx;
  log('[WORKDAY] Filling "My Experience" step...');

  // Resume upload — most important action on this step
  await wdUploadResume(page, fieldAnswers.resumePath, ctx);
  await humanDelay(page, 600, 1200);

  // LinkedIn URL — present on many Workday experience steps
  if (fieldAnswers.linkedin) {
    await wdFindAndFill(page, [
      '[data-automation-id="linkedinProfileUrl"]',
      '[aria-label="LinkedIn Profile"]',
      '[aria-label="LinkedIn URL"]',
      '[aria-label="LinkedIn Profile URL"]',
      'input[placeholder*="linkedin" i]',
    ], fieldAnswers.linkedin, 'LinkedIn Profile URL', ctx);
    await humanDelay(page, 200, 400);
  }

  // Portfolio / personal website
  if (fieldAnswers.portfolio) {
    await wdFindAndFill(page, [
      '[data-automation-id="websiteUrl"]',
      '[aria-label="Website URL"]',
      '[aria-label="Portfolio URL"]',
      '[aria-label="Personal Website"]',
      'input[placeholder*="portfolio" i]',
      'input[placeholder*="website" i]',
    ], fieldAnswers.portfolio, 'Portfolio / Website', ctx);
  }

  await randomMouseMove(page);
  log('[WORKDAY] "My Experience" step complete.');
}

/**
 * Fill the "Application Questions" step — employer-configured custom questions.
 *
 * These questions vary completely by company. Strategy:
 *   1. Scan all visible label elements on the page
 *   2. For each label, try to match against the Section H answers from the eval report
 *   3. Also check well-known pattern matches (why this role, salary, work auth, etc.)
 *   4. If matched, fill the associated textarea/input
 *
 * Questions with no matching answer are left blank — we warn but don't abort.
 *
 * @param {import('playwright').Page} page
 * @param {object} fieldAnswers
 * @param {object} ctx
 */
async function fillApplicationQuestions(page, fieldAnswers, ctx) {
  const { log } = ctx;
  log('[WORKDAY] Filling "Application Questions" step...');

  const customAnswers = fieldAnswers.customAnswers ?? {};
  const customKeys    = Object.keys(customAnswers);

  // Harvest all visible question labels from the page DOM
  const questionLabels = await page.evaluate(() => {
    const SKIP_PATTERNS = [
      'first name', 'last name', 'email', 'phone', 'resume', 'address',
      'city', 'zip', 'postal', 'state', 'country', 'linkedin', 'portfolio',
    ];

    const labels = Array.from(document.querySelectorAll(
      'label, [data-automation-id*="label"]:not(script), .gwt-Label'
    ));

    return labels
      .map(l => l.textContent?.trim().replace(/\s+/g, ' ') ?? '')
      .filter(text => {
        const lower = text.toLowerCase();
        return (
          text.length > 8 &&
          !SKIP_PATTERNS.some(p => lower.includes(p))
        );
      })
      .filter((v, i, arr) => arr.indexOf(v) === i);  // deduplicate
  }).catch(() => []);

  log(`[WORKDAY] Found ${questionLabels.length} potential question labels.`);

  for (const labelText of questionLabels) {
    // Determine the best answer to use for this label
    let answer = null;

    // 1. Exact/substring match against Section H custom answers
    const matchKey = customKeys.find(k =>
      labelText.toLowerCase().includes(k.toLowerCase()) ||
      k.toLowerCase().includes(labelText.toLowerCase().replace(/[?*:]/g, '').trim())
    );
    if (matchKey) answer = customAnswers[matchKey];

    // 2. Well-known field patterns
    if (!answer) {
      const ll = labelText.toLowerCase();
      if (/cover letter/i.test(ll) && fieldAnswers.coverLetter) {
        answer = fieldAnswers.coverLetter;
      } else if (/why.*(this role|role|position)|interest(ed)? in this/i.test(ll) && fieldAnswers.whyThisRole) {
        answer = fieldAnswers.whyThisRole;
      } else if (/why.*(this company|company)|want to work/i.test(ll) && fieldAnswers.whyThisCompany) {
        answer = fieldAnswers.whyThisCompany;
      } else if (/salary|compensation|pay expectat/i.test(ll) && fieldAnswers.salaryExpectation) {
        answer = fieldAnswers.salaryExpectation;
      } else if (/work auth|authorized to work|sponsorship|eligible to work/i.test(ll) && fieldAnswers.workAuthorization) {
        answer = fieldAnswers.workAuthorization;
      }
    }

    if (!answer) {
      // No answer for this question — skip silently (not all questions require answers)
      continue;
    }

    await wdFillCustomQuestion(page, labelText, answer, ctx);
    await humanDelay(page, 250, 550);
  }

  // Work authorization — Workday sometimes renders this as a Yes/No combobox
  // rather than a text field. Try to handle both.
  if (fieldAnswers.workAuthorization) {
    const authTrigger = page.locator(
      '[aria-label*="authorized" i] [role="combobox"], ' +
      '[aria-label*="authorization" i] [role="combobox"], ' +
      '[data-automation-id*="workAuth"] [role="combobox"]'
    ).first();
    const authVisible = await authTrigger.isVisible({ timeout: 2000 }).catch(() => false);

    if (authVisible) {
      const isYes = /yes|authorized|citizen|no.*sponsor/i.test(fieldAnswers.workAuthorization);
      await wdSelectDropdown(
        page,
        '[aria-label*="authorized" i] [role="combobox"], [data-automation-id*="workAuth"] [role="combobox"]',
        isYes ? 'Yes' : 'No',
        'Work Authorization',
        ctx
      ).catch(() => {});
    }
  }

  await randomMouseMove(page);
  log('[WORKDAY] "Application Questions" step complete.');
}

/**
 * Fill the "Voluntary Disclosures" / EEO step.
 *
 * Default policy: select "Decline to self-identify" or "I don't wish to answer"
 * for every EEO dropdown and radio. This is the safest, most privacy-preserving
 * default. If the profile has explicit EEO preferences, those can be added here.
 *
 * @param {import('playwright').Page} page
 * @param {object} fieldAnswers
 * @param {object} ctx
 */
async function fillVoluntaryDisclosures(page, fieldAnswers, ctx) {
  const { dryRun, log, filled, warnings } = ctx;
  log('[WORKDAY] Filling "Voluntary Disclosures" step (defaulting to Decline)...');

  try {
    // Handle all combobox dropdowns on this step
    const comboboxes = await page.locator('[role="combobox"]').all();

    for (const combo of comboboxes) {
      const isVisible = await combo.isVisible({ timeout: 1000 }).catch(() => false);
      if (!isVisible) continue;

      const ariaLabel = await combo.getAttribute('aria-label').catch(() => 'EEO field');
      const labelText = ariaLabel ?? 'EEO field';

      if (!dryRun) {
        await combo.click();
        await humanDelay(page, 350, 650);

        // Look for a "decline" / "prefer not" option
        const declineOpts = [
          `${WD.PROMPT_OPTION}:has-text("Decline")`,
          `${WD.PROMPT_OPTION}:has-text("prefer not")`,
          `${WD.PROMPT_OPTION}:has-text("don't wish")`,
          `${WD.PROMPT_OPTION}:has-text("do not wish")`,
          `${WD.PROMPT_OPTION}:has-text("Choose not")`,
        ];

        let declined = false;
        for (const decSel of declineOpts) {
          const opt = page.locator(decSel).first();
          const optVisible = await opt.isVisible({ timeout: 2000 }).catch(() => false);
          if (optVisible) {
            await opt.click();
            declined = true;
            break;
          }
        }

        if (!declined) {
          // Close without selecting
          await page.keyboard.press('Escape').catch(() => {});
          continue;
        }

        await humanDelay(page, 200, 400);
      }

      log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} [WORKDAY] EEO "${labelText}": "Decline to self-identify"`);
      filled.push({ label: `EEO: ${labelText}`, value: 'Decline to self-identify', selector: '[role="combobox"]' });
    }

    // Handle radio-button EEO questions (veteran status, disability, etc.)
    const radios = await page.locator('input[type="radio"]').all();
    for (const radio of radios) {
      const radioLabel = await radio.getAttribute('aria-label').catch(() => '');
      if (/decline|prefer not|don't wish|do not wish|choose not/i.test(radioLabel)) {
        if (!dryRun) await radio.click().catch(() => {});
        log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} [WORKDAY] EEO radio: "${radioLabel}"`);
        filled.push({ label: `EEO radio: ${radioLabel}`, value: radioLabel, selector: 'input[type="radio"]' });
      }
    }
  } catch (err) {
    warnings.push(`[WORKDAY] Voluntary disclosures handling failed: ${err.message}`);
  }

  log('[WORKDAY] "Voluntary Disclosures" step complete.');
}

// ── Main adapter — fillForm ───────────────────────────────────────────────────

/**
 * Fill all fields in a Workday application form across all steps.
 *
 * IMPORTANT: Workday must run headed (non-headless) — headless Chromium is blocked
 * by Workday's bot detection. Always pass { headless: false } to chromium.launch().
 *
 * Multi-step flow:
 *   My Information → My Experience → Application Questions →
 *   Voluntary Disclosures → Review and Submit
 *
 * Stops at the Review step (dry-run safety point). Call submitForm() separately.
 *
 * @param {import('playwright').Page} page          Playwright page object
 * @param {object}                    fieldAnswers  Output of buildFieldAnswers()
 * @param {object}                    [options]
 * @param {boolean}                   [options.dryRun=true]    Fill but don't submit
 * @param {Function}                  [options.log=console.log] Logging function
 * @param {string}                    [options.company]        Company name (for report)
 * @param {string}                    [options.role]           Role title (for report)
 * @returns {Promise<FilledForm>}
 */
export async function fillForm(page, fieldAnswers, options = {}) {
  const {
    dryRun  = true,
    log     = console.log,
    company = fieldAnswers?._report?.company ?? 'Unknown',
    role    = fieldAnswers?._report?.role    ?? 'Unknown',
  } = options;

  const filled   = [];  // FieldRecord[]  — { label, value, selector }
  const skipped  = [];  // string[]       — human-readable skip reasons
  const warnings = [];  // string[]       — non-fatal issues
  const ctx = { dryRun, log, filled, skipped, warnings };

  const prefix = dryRun ? '[DRY RUN]' : '[LIVE]';

  log(`\n${prefix} [WORKDAY] ══════════════════════════════════════════`);
  log(`${prefix} [WORKDAY] Starting Workday form fill`);
  log(`${prefix} [WORKDAY] Company: ${company} | Role: ${role}`);
  log(`${prefix} [WORKDAY] URL: ${page.url()}`);
  log(`${prefix} [WORKDAY] ⚠️  Must run headed (non-headless) — Workday blocks headless Chromium`);
  log(`${prefix} [WORKDAY] ══════════════════════════════════════════`);

  // ── Phase 0: Pre-flight CAPTCHA check ─────────────────────────────────
  if (await detectCaptcha(page)) {
    warnings.push('CAPTCHA detected before navigation — please solve it in the browser window');
    log(`${prefix} [WORKDAY] ⚠️  CAPTCHA detected. Please solve it. Waiting 60 seconds...`);
    await page.waitForTimeout(60_000).catch(() => {});
  }

  // ── Phase 1: Navigate to the application form ─────────────────────────
  const reachedForm = await navigateToApplicationForm(page, log);
  if (!reachedForm) {
    warnings.push('Could not confirm reaching the Workday application form — proceeding anyway');
  }

  // ── Phase 2: Post-navigation CAPTCHA check ────────────────────────────
  if (await detectCaptcha(page)) {
    warnings.push('CAPTCHA detected after navigation — manual intervention required');
    log(`${prefix} [WORKDAY] ⚠️  CAPTCHA detected. Please solve it. Waiting up to 3 minutes...`);

    try {
      await page.waitForFunction(
        () => !document.querySelector(
          '[data-automation-id="captcha"], iframe[src*="recaptcha"], iframe[src*="captcha"]'
        ),
        { timeout: 180_000 }
      );
      log(`${prefix} [WORKDAY] CAPTCHA appears resolved. Resuming.`);
    } catch {
      return {
        filled, skipped,
        warnings: [...warnings, 'CAPTCHA not resolved within 3 minutes — automation aborted'],
        screenshotPath: null,
        ats: 'workday',
        jobUrl: page.url(),
        company,
        role,
      };
    }
  }

  // ── Phase 3: Multi-step form fill loop ────────────────────────────────
  //
  // We iterate through Workday steps, detect the step name, dispatch to the
  // appropriate handler, then click Next. We stop when we hit the Review step
  // or when no Next button is found.
  //
  // Safety cap: MAX_STEPS prevents an infinite loop if Workday changes its structure.

  const MAX_STEPS = 10;

  for (let stepNum = 0; stepNum < MAX_STEPS; stepNum++) {
    const currentStep = await getCurrentStep(page);
    log(`\n${prefix} [WORKDAY] ─── Step ${stepNum + 1}: "${currentStep}" ───`);

    // Per-step CAPTCHA guard
    if (await detectCaptcha(page)) {
      warnings.push(`CAPTCHA detected on step "${currentStep}" — manual intervention required`);
      log(`${prefix} [WORKDAY] ⚠️  CAPTCHA on step "${currentStep}". Please solve it.`);
      await page.waitForTimeout(30_000).catch(() => {});
    }

    const stepLower = currentStep.toLowerCase();

    // ── Dispatch to the correct step handler ─────────────────────────
    if (
      stepLower.includes('information') ||
      stepLower.includes('personal') ||
      stepLower.includes('contact') ||
      stepNum === 0   // First step is almost always My Information
    ) {
      await fillMyInformation(page, fieldAnswers, ctx);

    } else if (
      stepLower.includes('experience') ||
      stepLower.includes('resume') ||
      stepLower.includes('background') ||
      stepLower.includes('qualification')
    ) {
      await fillMyExperience(page, fieldAnswers, ctx);

    } else if (
      stepLower.includes('question') ||
      stepLower.includes('additional') ||
      stepLower.includes('screening')
    ) {
      await fillApplicationQuestions(page, fieldAnswers, ctx);

    } else if (
      stepLower.includes('disclosure') ||
      stepLower.includes('voluntary') ||
      stepLower.includes('demographic') ||
      stepLower.includes('equal employment') ||
      stepLower.includes('eeo')
    ) {
      await fillVoluntaryDisclosures(page, fieldAnswers, ctx);

    } else if (
      stepLower.includes('review') ||
      stepLower.includes('submit') ||
      stepLower.includes('confirm') ||
      stepLower.includes('summary')
    ) {
      // Review / Submit step — this is the dry-run safety checkpoint.
      // We do NOT click Submit here; submitForm() handles that.
      log(`\n${prefix} [WORKDAY] Reached Review/Submit step — stopping fill.`);
      if (dryRun) {
        log(`${prefix} [WORKDAY] DRY RUN complete. Review the filled form above.`);
        log(`${prefix} [WORKDAY] Run with --submit and call submitForm() to submit.`);
        warnings.push('DRY RUN: Stopped at Review step — use submitForm() to complete submission');
      }
      break;

    } else {
      // Unknown step label — use the Application Questions handler as a generic fallback.
      // This catches any new steps Workday adds or tenant-specific naming variations.
      log(`${prefix} [WORKDAY] Unrecognised step "${currentStep}" — using generic question handler.`);
      await fillApplicationQuestions(page, fieldAnswers, ctx);
    }

    // ── Check if we landed on the Review step after filling ───────────
    if (await isOnReviewStep(page)) {
      log(`${prefix} [WORKDAY] Now on Review step. Stopping fill.`);
      if (dryRun) {
        warnings.push('DRY RUN: Stopped at Review step — use submitForm() to complete submission');
      }
      break;
    }

    // ── Check if the Submit button is now visible (some forms skip "Review" label) ──
    const submitNow = await page.locator(WD.SUBMIT_BUTTON).isVisible({ timeout: 2000 }).catch(() => false);
    if (submitNow) {
      log(`${prefix} [WORKDAY] Submit button visible — at final step. Stopping fill.`);
      if (dryRun) {
        warnings.push('DRY RUN: At final step — use submitForm() to complete submission');
      }
      break;
    }

    // ── Advance to next step ──────────────────────────────────────────
    const advanced = await clickNext(page, log);
    if (!advanced) {
      warnings.push(`[WORKDAY] Could not advance past step "${currentStep}" — stopped`);
      log(`${prefix} [WORKDAY] ⚠️  No Next button found on step "${currentStep}". Stopping.`);
      break;
    }
  }

  // ── Phase 4: Save session state for future runs ────────────────────────
  try {
    const browserContext = page.context();
    await saveSession(browserContext, log);
  } catch {
    // Session save is best-effort — don't fail the whole run
  }

  // ── Done ───────────────────────────────────────────────────────────────
  const jobUrl = page.url();

  log(`\n${prefix} [WORKDAY] Form fill complete.`);
  log(`  Fields filled:  ${filled.length}`);
  log(`  Fields skipped: ${skipped.length}`);
  log(`  Warnings:       ${warnings.length}`);

  return {
    filled,
    skipped,
    warnings,
    screenshotPath: null,   // caller (index.mjs) takes the screenshot
    ats: 'workday',
    jobUrl,
    company,
    role,
  };
}

// ── submitForm ────────────────────────────────────────────────────────────────

/**
 * Submit the Workday application.
 *
 * Called from index.mjs ONLY after human confirmation (--submit flag + "yes" prompt).
 * At this point the browser should be on the Review/Submit step with the Submit button visible.
 *
 * Waits for the confirmation dialog or URL change before returning.
 *
 * @param {import('playwright').Page} page
 * @param {Function} [log]
 * @returns {Promise<{ success: boolean, confirmationUrl: string|null, message: string }>}
 */
export async function submitForm(page, log = console.log) {
  try {
    log('[LIVE] [WORKDAY] Locating Submit Application button...');

    // Primary: data-automation-id
    let submitBtn = page.locator(WD.SUBMIT_BUTTON).first();
    let btnVisible = await submitBtn.isVisible({ timeout: 5000 }).catch(() => false);

    // Fallback: text-based
    if (!btnVisible) {
      submitBtn = page.locator(
        'button:has-text("Submit Application"), button:has-text("Submit")'
      ).first();
      btnVisible = await submitBtn.isVisible({ timeout: 3000 }).catch(() => false);
    }

    if (!btnVisible) {
      return {
        success: false,
        confirmationUrl: null,
        message: '[WORKDAY] Submit button not found — ensure fillForm() completed and browser is on the Review step',
      };
    }

    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    log('[LIVE] [WORKDAY] Clicking Submit Application...');
    await submitBtn.click();

    // Wait for confirmation — Workday can show a dialog or navigate to a new URL
    try {
      await Promise.race([
        page.waitForSelector(WD.CONFIRMATION, { timeout: 25_000 }),
        page.waitForSelector(WD.SUCCESS_NOTIFICATION, { timeout: 25_000 }),
        page.waitForURL('**thank**',     { timeout: 25_000 }),
        page.waitForURL('**confirm**',   { timeout: 25_000 }),
        page.waitForURL('**success**',   { timeout: 25_000 }),
        page.waitForURL('**submitted**', { timeout: 25_000 }),
      ]);
    } catch {
      // None of the above matched within 25s — check page content for success signals
      const hasSuccessText = await page.evaluate(() => {
        const body = document.body.textContent.toLowerCase();
        return (
          body.includes('thank you') ||
          body.includes('application submitted') ||
          body.includes('received your application') ||
          body.includes('we have received') ||
          body.includes('submission complete')
        );
      }).catch(() => false);

      if (!hasSuccessText) {
        return {
          success: false,
          confirmationUrl: page.url(),
          message: '[WORKDAY] Submission may have failed — no confirmation detected. Check the browser window.',
        };
      }
    }

    const confirmationUrl = page.url();
    log(`[LIVE] [WORKDAY] Application submitted successfully.`);
    log(`[LIVE] [WORKDAY] Confirmation URL: ${confirmationUrl}`);

    return {
      success: true,
      confirmationUrl,
      message: 'Workday application submitted successfully',
    };
  } catch (err) {
    return {
      success: false,
      confirmationUrl: null,
      message: `[WORKDAY] Submit error: ${err.message}`,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncate(s, max) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
