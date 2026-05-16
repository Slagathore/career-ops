/**
 * apply-engine/adapters/ashby.mjs
 *
 * Playwright adapter for Ashby HQ application forms.
 *
 * Ashby hosts React SPA applications at:
 *   https://jobs.ashbyhq.com/<company>/<job-id>/application
 *
 * Key challenges vs. Greenhouse:
 *   - React SPA — fields dynamically rendered; custom combobox dropdowns (not native <select>)
 *   - Multi-step forms — may have "Next"/"Continue" buttons between pages
 *   - Cover letter can be a plain <textarea> OR a contenteditable rich-text editor
 *   - File upload is always present but hidden behind Ashby's own button UI
 *
 * Usage:
 *   import { fillForm, submitForm } from './adapters/ashby.mjs';
 *   const result = await fillForm(page, fieldAnswers, { dryRun: true, log, company, role });
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncate(s, max) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

/**
 * Try a list of selectors in order; return the first one that is visible.
 * Returns null if none match within the timeout.
 */
async function firstVisible(page, selectors, timeoutMs = 3000) {
  for (const sel of Array.isArray(selectors) ? selectors : [selectors]) {
    try {
      const el = page.locator(sel).first();
      const visible = await el.isVisible({ timeout: timeoutMs }).catch(() => false);
      if (visible) return el;
    } catch {
      // try next
    }
  }
  return null;
}

// ── Field fill helpers ────────────────────────────────────────────────────────

/**
 * Fill a text input from a prioritised list of selectors.
 */
async function fillText(page, selectors, value, label, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  if (!value) {
    skipped.push(`"${label}" — no value in profile/report`);
    return false;
  }
  try {
    const el = await firstVisible(page, selectors);
    if (!el) {
      skipped.push(`"${label}" — field not found on page`);
      return false;
    }
    await el.scrollIntoViewIfNeeded();
    if (!dryRun) {
      await el.fill('');
      await el.fill(value);
    }
    log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Filled "${label}": "${truncate(value, 60)}"`);
    filled.push({ label, value, selector: Array.isArray(selectors) ? selectors[0] : selectors });
    return true;
  } catch (err) {
    warnings.push(`"${label}" — fill failed: ${err.message}`);
    return false;
  }
}

/**
 * Upload a resume via Ashby's file input.
 * Ashby always has an `input[type="file"]`, typically hidden behind a styled button.
 * We bypass the button and call setInputFiles() directly.
 */
async function uploadResume(page, resumePath, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  if (!resumePath) {
    skipped.push('"Resume" — no PDF found in output/ directory');
    return false;
  }
  try {
    // First try: any file input visible or hidden (Ashby usually hides it)
    const fileInput = page.locator('input[type="file"]').first();
    const exists = await fileInput.count().then(n => n > 0).catch(() => false);
    if (!exists) {
      skipped.push('"Resume" — file input not found on page');
      return false;
    }

    if (!dryRun) {
      // setInputFiles works even on hidden file inputs
      await fileInput.setInputFiles(resumePath);
    }
    log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Uploaded resume: ${resumePath}`);
    filled.push({ label: 'Resume (PDF)', value: resumePath, selector: 'input[type="file"]' });
    return true;
  } catch (err) {
    warnings.push(`Resume upload failed: ${err.message}`);
    return false;
  }
}

/**
 * Fill a cover letter — handles both plain <textarea> and contenteditable rich-text editors.
 * Ashby sometimes uses a draft-js or Tiptap editor (contenteditable div).
 */
async function fillCoverLetter(page, coverLetter, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  if (!coverLetter) {
    skipped.push('"Cover Letter" — no cover letter in report Section H');
    return false;
  }

  try {
    // Strategy 1: plain <textarea> — find by data-testid or by label proximity
    const textareaSelectors = [
      'textarea[data-testid*="cover-letter"]',
      'textarea[data-testid*="coverLetter"]',
      'textarea[data-testid*="cover_letter"]',
    ];

    const textareaByTestId = await firstVisible(page, textareaSelectors, 2000);
    if (textareaByTestId) {
      await textareaByTestId.scrollIntoViewIfNeeded();
      if (!dryRun) {
        await textareaByTestId.fill('');
        await textareaByTestId.fill(coverLetter);
      }
      log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Filled "Cover Letter" (textarea testid): ${coverLetter.length} chars`);
      filled.push({ label: 'Cover Letter', value: coverLetter, selector: textareaSelectors[0] });
      return true;
    }

    // Strategy 2: find textarea by label text match
    const textareaById = await page.evaluate((searchText) => {
      const labels = Array.from(document.querySelectorAll('label, p, span'));
      const labelEl = labels.find(l =>
        l.textContent.toLowerCase().includes(searchText.toLowerCase())
      );
      if (!labelEl) return null;
      const container = labelEl.closest('[class*="field"], [class*="question"], [class*="form"], fieldset, div');
      const ta = container?.querySelector('textarea');
      return ta?.id || null;
    }, 'cover letter');

    if (textareaById) {
      const el = page.locator(`#${textareaById}`);
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await el.scrollIntoViewIfNeeded();
        if (!dryRun) {
          await el.fill('');
          await el.fill(coverLetter);
        }
        log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Filled "Cover Letter" (label-matched textarea): ${coverLetter.length} chars`);
        filled.push({ label: 'Cover Letter', value: coverLetter, selector: `#${textareaById}` });
        return true;
      }
    }

    // Strategy 3: contenteditable rich-text editor
    const editorId = await page.evaluate((searchText) => {
      const labels = Array.from(document.querySelectorAll('label, p, span, h3, h4'));
      const labelEl = labels.find(l =>
        l.textContent.toLowerCase().includes(searchText.toLowerCase())
      );
      if (!labelEl) return null;
      const container = labelEl.closest('[class*="field"], [class*="question"], [class*="form"], fieldset, div');
      const editor = container?.querySelector('[contenteditable="true"]');
      return editor?.id || (editor ? '__CONTENTEDITABLE__' : null);
    }, 'cover letter');

    if (editorId) {
      const editorSel = editorId === '__CONTENTEDITABLE__'
        ? '[contenteditable="true"]'
        : `#${editorId}`;
      const editorEl = page.locator(editorSel).first();
      const visible = await editorEl.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await editorEl.scrollIntoViewIfNeeded();
        if (!dryRun) {
          await editorEl.click();
          // Select all + type replaces existing content in contenteditable
          await page.keyboard.press('Control+a');
          await page.keyboard.type(coverLetter);
        }
        log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Filled "Cover Letter" (contenteditable): ${coverLetter.length} chars`);
        filled.push({ label: 'Cover Letter', value: coverLetter, selector: editorSel });
        return true;
      }
    }

    warnings.push('"Cover Letter" — field not found (tried textarea + contenteditable)');
    return false;
  } catch (err) {
    warnings.push(`"Cover Letter" fill failed: ${err.message}`);
    return false;
  }
}

/**
 * Handle Ashby's custom combobox dropdowns.
 * Ashby uses a custom React select with role="combobox" or aria-haspopup="listbox".
 *
 * Pattern:
 *   1. Find the trigger element near a label containing the search text
 *   2. Click the trigger to open the dropdown
 *   3. Wait for the options list (role="listbox" or aria-expanded="true")
 *   4. Click the option whose text best matches the preferred value
 */
async function fillCombobox(page, labelText, preferredValue, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  if (!preferredValue) {
    skipped.push(`"${labelText}" combobox — no preferred value`);
    return false;
  }

  try {
    // First, check for a native <select> near the label — some Ashby forms still use them
    const nativeSelectId = await page.evaluate((label) => {
      const labels = Array.from(document.querySelectorAll('label'));
      const labelEl = labels.find(l => l.textContent.toLowerCase().includes(label.toLowerCase()));
      if (!labelEl) return null;
      const container = labelEl.closest('[class*="field"], [class*="question"], fieldset, div');
      const sel = container?.querySelector('select') ?? document.getElementById(labelEl.htmlFor);
      if (sel?.tagName === 'SELECT') return sel.id;
      return null;
    }, labelText);

    if (nativeSelectId) {
      const sel = page.locator(`#${nativeSelectId}`);
      const options = await sel.locator('option').allTextContents();
      const best = options.find(o => o.toLowerCase().includes(preferredValue.toLowerCase()))
        ?? options.find(o => preferredValue.toLowerCase().includes(o.toLowerCase().trim()));
      if (best) {
        await sel.scrollIntoViewIfNeeded();
        if (!dryRun) await sel.selectOption({ label: best });
        log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Selected "${labelText}" (native select): "${best}"`);
        filled.push({ label: labelText, value: best, selector: `#${nativeSelectId}` });
        return true;
      }
      warnings.push(`"${labelText}" — no matching option for "${preferredValue}". Available: ${options.slice(0, 5).join(', ')}`);
      return false;
    }

    // Find the combobox trigger near the label
    const triggerInfo = await page.evaluate((label) => {
      const labels = Array.from(document.querySelectorAll('label, p, span'));
      const labelEl = labels.find(l => l.textContent.toLowerCase().includes(label.toLowerCase()));
      if (!labelEl) return null;
      const container = labelEl.closest('[class*="field"], [class*="question"], fieldset, div') ?? labelEl.parentElement;
      if (!container) return null;
      const trigger =
        container.querySelector('[role="combobox"]') ??
        container.querySelector('[aria-haspopup="listbox"]') ??
        container.querySelector('[aria-haspopup="true"]');
      return trigger ? { id: trigger.id || null, testId: trigger.dataset?.testid || null } : null;
    }, labelText);

    if (!triggerInfo) {
      skipped.push(`"${labelText}" combobox — trigger element not found`);
      return false;
    }

    const triggerSel = triggerInfo.id
      ? `#${triggerInfo.id}`
      : triggerInfo.testId
        ? `[data-testid="${triggerInfo.testId}"]`
        : `[aria-label*="${labelText}"]`;

    const trigger = page.locator(triggerSel).first();
    const visible = await trigger.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) {
      skipped.push(`"${labelText}" combobox — trigger not visible`);
      return false;
    }

    if (dryRun) {
      log(`[DRY RUN] Would select "${labelText}" combobox: "${preferredValue}"`);
      filled.push({ label: labelText, value: preferredValue, selector: triggerSel });
      return true;
    }

    // Open the dropdown
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();

    // Wait for options to appear
    await page.waitForSelector('[role="listbox"], [role="option"]', { timeout: 5000 }).catch(() => {});

    // Find and click the matching option
    const optionClicked = await page.evaluate((preferred) => {
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      const match = options.find(o => o.textContent.toLowerCase().includes(preferred.toLowerCase()))
        ?? options.find(o => preferred.toLowerCase().includes(o.textContent.toLowerCase().trim()));
      if (match) {
        match.click();
        return match.textContent.trim();
      }
      return null;
    }, preferredValue);

    if (!optionClicked) {
      // Close the dropdown to avoid blocking other interactions
      await page.keyboard.press('Escape').catch(() => {});
      warnings.push(`"${labelText}" combobox — no option matching "${preferredValue}"`);
      return false;
    }

    // Wait for dropdown to close
    await page.waitForSelector('[role="listbox"]', { state: 'hidden', timeout: 3000 }).catch(() => {});

    log(`[LIVE] Selected "${labelText}" combobox: "${optionClicked}"`);
    filled.push({ label: labelText, value: optionClicked, selector: triggerSel });
    return true;
  } catch (err) {
    warnings.push(`"${labelText}" combobox — ${err.message}`);
    return false;
  }
}

/**
 * Fill Ashby's custom question fields.
 *
 * Ashby renders labeled fieldsets above the input. Labels are in <label> or <p> tags.
 * We try to match each label against fieldAnswers.customAnswers.
 */
async function fillCustomQuestions(page, fieldAnswers, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  try {
    const questionLabels = await page.evaluate(() => {
      const HANDLED = [
        'first name', 'last name', 'full name', 'name',
        'email', 'phone', 'resume', 'cover letter',
        'linkedin', 'website', 'portfolio', 'github',
        'authorized to work', 'work authorization',
      ];

      // Ashby renders questions in divs with role or data attributes, or in labeled sections
      const labels = Array.from(document.querySelectorAll(
        'label, [class*="label"], [class*="question"] p, [class*="field"] p'
      ));

      return labels
        .map(l => ({
          text: l.textContent.trim().replace(/\s+/g, ' '),
          forId: l.htmlFor || null,
        }))
        .filter(({ text }) => {
          const lower = text.toLowerCase();
          return !HANDLED.some(h => lower.includes(h)) && text.length > 3 && text.length < 300;
        })
        // Deduplicate by text
        .filter((v, i, a) => a.findIndex(x => x.text === v.text) === i);
    });

    const customAnswers = fieldAnswers.customAnswers ?? {};
    const customKeys    = Object.keys(customAnswers);

    for (const { text: labelText, forId } of questionLabels) {
      const matchKey = customKeys.find(k =>
        labelText.toLowerCase().includes(k.toLowerCase()) ||
        k.toLowerCase().includes(labelText.toLowerCase().replace(/[?*]/g, ''))
      );

      const answer = matchKey ? customAnswers[matchKey] : null;

      if (!answer) {
        skipped.push(`"${labelText}" — no matching answer in report Section H`);
        continue;
      }

      // Try to find the associated input or textarea
      const inputSel = forId ? `#${forId}` : null;

      if (inputSel) {
        const el = page.locator(inputSel).first();
        const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          const tag = await el.evaluate(n => n.tagName).catch(() => '');
          await el.scrollIntoViewIfNeeded();
          if (!dryRun) {
            await el.fill('');
            await el.fill(answer);
          }
          log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Filled custom "${labelText}": "${truncate(answer, 60)}"`);
          filled.push({ label: labelText, value: answer, selector: inputSel });
          continue;
        }
      }

      // Fallback: find textarea/input in the same container as the label
      const foundInput = await page.evaluate((labelSearch) => {
        const labels = Array.from(document.querySelectorAll('label, p, span'));
        const labelEl = labels.find(l => l.textContent.trim().toLowerCase().includes(labelSearch.toLowerCase()));
        if (!labelEl) return null;
        const container = labelEl.closest('[class*="field"], [class*="question"], fieldset, div');
        const input = container?.querySelector('textarea') ?? container?.querySelector('input[type="text"]');
        return input?.id ?? null;
      }, labelText);

      if (foundInput) {
        const el = page.locator(`#${foundInput}`);
        const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          await el.scrollIntoViewIfNeeded();
          if (!dryRun) {
            await el.fill('');
            await el.fill(answer);
          }
          log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Filled custom "${labelText}" (container match): "${truncate(answer, 60)}"`);
          filled.push({ label: labelText, value: answer, selector: `#${foundInput}` });
          continue;
        }
      }

      warnings.push(`"${labelText}" custom question — could not find associated input`);
    }
  } catch (err) {
    warnings.push(`Custom questions scan failed: ${err.message}`);
  }
}

/**
 * Handle a single form "page" (step).
 * Fills all visible fields; does NOT click Next/Submit — that's handled by the caller.
 */
async function fillCurrentStep(page, fieldAnswers, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  const prefix = dryRun ? '[DRY RUN]' : '[LIVE]';

  // ── Name fields ───────────────────────────────────────────────────────────
  // Check if Ashby uses split first/last or a single full-name field
  const hasFirstName = await firstVisible(page, [
    'input[data-testid*="first"]',
    'input[placeholder="First name"]',
    'input[placeholder="First Name"]',
  ], 1500);

  if (hasFirstName) {
    await fillText(page, [
      'input[data-testid*="first"]',
      'input[placeholder="First name"]',
      'input[placeholder="First Name"]',
    ], fieldAnswers.firstName, 'First Name', ctx);

    await fillText(page, [
      'input[data-testid*="last"]',
      'input[placeholder="Last name"]',
      'input[placeholder="Last Name"]',
    ], fieldAnswers.lastName, 'Last Name', ctx);
  } else {
    // Try full-name field
    const fullName = `${fieldAnswers.firstName} ${fieldAnswers.lastName}`.trim();
    await fillText(page, [
      'input[data-testid*="name"]',
      'input[placeholder*="Full name"]',
      'input[placeholder*="Your name"]',
      'input[placeholder*="Name"]',
    ], fullName, 'Full Name', ctx);
  }

  // ── Email ─────────────────────────────────────────────────────────────────
  await fillText(page, [
    'input[type="email"]',
    'input[data-testid*="email"]',
    'input[placeholder*="email"]',
    'input[placeholder*="Email"]',
  ], fieldAnswers.email, 'Email', ctx);

  // ── Phone ─────────────────────────────────────────────────────────────────
  await fillText(page, [
    'input[type="tel"]',
    'input[data-testid*="phone"]',
    'input[placeholder*="phone"]',
    'input[placeholder*="Phone"]',
  ], fieldAnswers.phone, 'Phone', ctx);

  // ── LinkedIn ──────────────────────────────────────────────────────────────
  await fillText(page, [
    'input[placeholder*="LinkedIn"]',
    'input[placeholder*="linkedin"]',
    'input[data-testid*="linkedin"]',
    'input[data-testid*="LinkedIn"]',
  ], fieldAnswers.linkedin, 'LinkedIn URL', ctx);

  // ── Resume upload ─────────────────────────────────────────────────────────
  await uploadResume(page, fieldAnswers.resumePath, ctx);

  // ── Cover letter ──────────────────────────────────────────────────────────
  await fillCoverLetter(page, fieldAnswers.coverLetter, ctx);

  // ── Work authorization ────────────────────────────────────────────────────
  if (fieldAnswers.workAuthorization) {
    // Try combobox first, then radio buttons
    const authCombobox = await firstVisible(page, [
      '[aria-label*="authorized"]',
      '[aria-label*="work authorization"]',
    ], 1500);

    if (authCombobox) {
      await fillCombobox(page, 'authorized to work', fieldAnswers.workAuthorization, ctx);
    } else {
      // Check for radio button group
      const hasAuthRadio = await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll('label, p'));
        return labels.some(l => l.textContent.toLowerCase().includes('authorized to work'));
      }).catch(() => false);

      if (hasAuthRadio) {
        // Find the radio option closest to our preferred value
        const radioClicked = await page.evaluate((preferred) => {
          const labels = Array.from(document.querySelectorAll('label'));
          const groupLabel = labels.find(l => l.textContent.toLowerCase().includes('authorized to work'));
          if (!groupLabel) return false;
          const container = groupLabel.closest('fieldset, [class*="field"], [class*="question"]') ?? groupLabel.parentElement;
          if (!container) return false;
          const radios = Array.from(container.querySelectorAll('input[type="radio"]'));
          for (const r of radios) {
            const rLabel = document.querySelector(`label[for="${r.id}"]`)?.textContent ?? r.value ?? '';
            if (rLabel.toLowerCase().includes(preferred.toLowerCase().includes('yes') ? 'yes' : 'no')) {
              window.__authRadioId = r.id;
              return true;
            }
          }
          return false;
        }, fieldAnswers.workAuthorization);

        if (radioClicked) {
          const radioId = await page.evaluate(() => window.__authRadioId);
          if (radioId && !dryRun) {
            await page.locator(`#${radioId}`).check().catch(() => {});
          }
          log(`${prefix} Checked "Work Authorization" radio: "${fieldAnswers.workAuthorization}"`);
          filled.push({ label: 'Work Authorization', value: fieldAnswers.workAuthorization, selector: `input[type="radio"]` });
        } else {
          skipped.push('"Work Authorization" — could not select radio option');
        }
      }
    }
  }

  // ── Custom questions ──────────────────────────────────────────────────────
  await fillCustomQuestions(page, fieldAnswers, ctx);
}

// ── Main adapter ──────────────────────────────────────────────────────────────

/**
 * Fill all fields in an Ashby application form.
 * Handles multi-step forms by detecting and clicking "Next"/"Continue" buttons.
 *
 * @param {import('playwright').Page} page
 * @param {object}  fieldAnswers  Output of buildFieldAnswers()
 * @param {object|boolean} [optionsOrDryRun]  Options object OR boolean dryRun shorthand
 * @returns {Promise<FilledForm>}
 */
export async function fillForm(page, fieldAnswers, optionsOrDryRun = {}) {
  // Accept both (page, answers, true/false) and (page, answers, { dryRun, log, ... })
  const options = typeof optionsOrDryRun === 'boolean'
    ? { dryRun: optionsOrDryRun }
    : optionsOrDryRun;

  const {
    dryRun  = true,
    log     = console.log,
    company = fieldAnswers?._report?.company ?? 'Unknown',
    role    = fieldAnswers?._report?.role    ?? 'Unknown',
  } = options;

  const filled   = [];
  const skipped  = [];
  const warnings = [];

  const ctx    = { dryRun, log, filled, skipped, warnings };
  const prefix = dryRun ? '[DRY RUN]' : '[LIVE]';

  log(`${prefix} Starting Ashby form fill — ${company} / ${role}`);

  // Wait for the React SPA to render the form
  try {
    await page.waitForSelector('form, [role="main"], [data-testid*="application"]', { timeout: 10_000 });
  } catch {
    warnings.push('Form container not detected — page may not have fully loaded');
  }

  // ── Multi-step loop ────────────────────────────────────────────────────────
  const MAX_STEPS = 8;  // safety limit
  let step = 0;

  while (step < MAX_STEPS) {
    step++;
    log(`${prefix} Filling step ${step}...`);

    // Give the current step's fields a moment to render
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(500).catch(() => {});

    await fillCurrentStep(page, fieldAnswers, ctx);

    // Check for "Next" / "Continue" button
    const nextBtn = await firstVisible(page, [
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button[type="button"]:has-text("Next")',
    ], 2000);

    if (!nextBtn) {
      log(`${prefix} No "Next" button found — reached final step (step ${step})`);
      break;
    }

    // Don't click Next in dry-run (we still want to fill and log)
    if (dryRun) {
      log(`[DRY RUN] Would click "Next" to proceed to step ${step + 1}`);
      filled.push({ label: `[Step ${step} → ${step + 1}]`, value: 'Next clicked', selector: 'button:has-text("Next")' });
      break;  // In dry-run, stop after first step (form isn't live)
    }

    log(`${prefix} Clicking "Next" → step ${step + 1}`);
    await nextBtn.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
  }

  if (step >= MAX_STEPS) {
    warnings.push(`Reached multi-step limit (${MAX_STEPS} steps) — form may have more pages`);
  }

  const jobUrl = page.url();

  log(`\n${prefix} Ashby form fill complete.`);
  log(`  Fields filled:  ${filled.length}`);
  log(`  Fields skipped: ${skipped.length}`);
  log(`  Warnings:       ${warnings.length}`);

  return {
    filled,
    skipped,
    warnings,
    screenshotPath: null,  // caller (index.mjs) takes the screenshot
    ats: 'ashby',
    jobUrl,
    company,
    role,
  };
}

/**
 * Submit the Ashby form.
 * Clicks the submit button and waits for a confirmation indicator.
 *
 * @param {import('playwright').Page} page
 * @param {Function} [log]
 * @returns {Promise<{ success: boolean, confirmationText: string }>}
 */
export async function submitForm(page, log = console.log) {
  try {
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Submit Application")',
      'button:has-text("Submit")',
    ];

    const submitBtn = await firstVisible(page, submitSelectors, 5000);
    if (!submitBtn) {
      return { success: false, confirmationText: 'Submit button not found' };
    }

    await submitBtn.scrollIntoViewIfNeeded();
    log('[LIVE] Clicking "Submit Application"...');
    await submitBtn.click();

    // Wait for a confirmation indicator
    try {
      await Promise.race([
        page.waitForURL('**/confirmation**', { timeout: 15_000 }),
        page.waitForURL('**/thank**',        { timeout: 15_000 }),
        page.waitForURL('**/success**',      { timeout: 15_000 }),
        page.waitForSelector(
          '[class*="confirmation"], [class*="success"], h1:has-text("Thank"), h2:has-text("Thank"), h1:has-text("Application submitted")',
          { timeout: 15_000 }
        ),
      ]);
    } catch {
      // Check for success text as last resort
      const hasSuccessText = await page.evaluate(() => {
        const body = document.body.textContent.toLowerCase();
        return (
          body.includes('thank you') ||
          body.includes('application submitted') ||
          body.includes('application received') ||
          (body.includes('application') && body.includes('success'))
        );
      }).catch(() => false);

      if (!hasSuccessText) {
        const currentUrl = page.url();
        return {
          success: false,
          confirmationText: `Submission may have failed — no confirmation detected. Current URL: ${currentUrl}`,
        };
      }
    }

    const confirmationText = await page.evaluate(() => {
      return document.querySelector('h1, h2, [class*="confirmation"], [class*="success"]')
        ?.textContent?.trim() ?? 'Application submitted';
    }).catch(() => 'Application submitted');

    log(`[LIVE] Ashby application submitted. Confirmation: "${confirmationText}"`);
    return { success: true, confirmationText };
  } catch (err) {
    return { success: false, confirmationText: `Submit error: ${err.message}` };
  }
}
