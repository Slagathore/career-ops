/**
 * apply-engine/adapters/lever.mjs
 *
 * Playwright adapter for Lever ATS application forms.
 *
 * Lever hosts forms at:
 *   https://jobs.lever.co/<company>/<job-id>/apply
 *
 * Form characteristics:
 *   - Classic server-rendered HTML with React enhancements for file upload
 *   - Single full-name field (not split first/last): input[name="name"]
 *   - Cover letter / additional info lives in textarea[name="comments"]
 *   - Custom fields use UUID-keyed inputs: input[name="cards[<uuid>][field<n>]"]
 *   - File upload: hidden input[type="file"] — bypass the button, call setInputFiles() directly
 *   - Native <select> dropdowns — use Playwright's selectOption()
 *   - Single-page form — no multi-step navigation
 *
 * Usage:
 *   import { fillForm, submitForm } from './adapters/lever.mjs';
 *   const result = await fillForm(page, fieldAnswers, { dryRun: true, log, company, role });
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncate(s, max) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

/**
 * Try a list of selectors; return the first visible element, or null.
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
 * Fill a named text input.
 */
async function fillText(page, selector, value, label, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  if (!value) {
    skipped.push(`"${label}" — no value in profile/report`);
    return false;
  }
  try {
    const el = page.locator(selector).first();
    const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) {
      skipped.push(`"${label}" — field not found (${selector})`);
      return false;
    }
    await el.scrollIntoViewIfNeeded();
    if (!dryRun) {
      await el.fill('');
      await el.fill(value);
    }
    log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Filled "${label}": "${truncate(value, 60)}"`);
    filled.push({ label, value, selector });
    return true;
  } catch (err) {
    warnings.push(`"${label}" — fill failed: ${err.message}`);
    return false;
  }
}

/**
 * Fill a <textarea> by CSS selector.
 */
async function fillTextarea(page, selector, value, label, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  if (!value) {
    skipped.push(`"${label}" textarea — no value available`);
    return false;
  }
  try {
    const el = page.locator(selector).first();
    const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) {
      skipped.push(`"${label}" textarea — not found (${selector})`);
      return false;
    }
    await el.scrollIntoViewIfNeeded();
    if (!dryRun) {
      await el.fill('');
      await el.fill(value);
    }
    log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Filled "${label}" textarea: ${value.length} chars`);
    filled.push({ label, value, selector });
    return true;
  } catch (err) {
    warnings.push(`"${label}" textarea — ${err.message}`);
    return false;
  }
}

/**
 * Upload the resume PDF.
 * Lever uses a hidden input[type="file"] behind a custom "Choose File" button.
 * We skip the button entirely and call setInputFiles() on the raw input.
 */
async function uploadResume(page, resumePath, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  if (!resumePath) {
    skipped.push('"Resume" — no PDF found in output/ directory');
    return false;
  }
  try {
    const fileInput = page.locator('input[type="file"]').first();
    const exists = await fileInput.count().then(n => n > 0).catch(() => false);
    if (!exists) {
      skipped.push('"Resume" — file input not found');
      return false;
    }
    if (!dryRun) {
      // Works regardless of whether the input is display:none
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
 * Handle a native Lever <select> dropdown.
 */
async function fillSelect(page, selector, label, preferredValue, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  if (!preferredValue) {
    skipped.push(`"${label}" dropdown — no preferred value`);
    return false;
  }
  try {
    const el = page.locator(selector).first();
    const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) {
      skipped.push(`"${label}" dropdown — not found`);
      return false;
    }
    const options = await el.locator('option').allTextContents();
    const best = options.find(o => o.toLowerCase().includes(preferredValue.toLowerCase()))
      ?? options.find(o => preferredValue.toLowerCase().includes(o.toLowerCase().trim()));

    if (!best) {
      warnings.push(`"${label}" — no option matching "${preferredValue}". Available: ${options.slice(0, 5).join(', ')}`);
      return false;
    }
    await el.scrollIntoViewIfNeeded();
    if (!dryRun) await el.selectOption({ label: best });
    log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Selected "${label}": "${best}"`);
    filled.push({ label, value: best, selector });
    return true;
  } catch (err) {
    warnings.push(`"${label}" dropdown — ${err.message}`);
    return false;
  }
}

/**
 * Check required consent + EEOC checkboxes on Lever forms.
 * Lever includes EEOC checkboxes and sometimes a consent checkbox.
 */
async function checkConsentBoxes(page, ctx) {
  const { dryRun, log, filled, warnings } = ctx;
  try {
    const checkboxIds = await page.evaluate(() => {
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      return checkboxes
        .filter(cb => {
          const label = (
            document.querySelector(`label[for="${cb.id}"]`)?.textContent ??
            cb.closest('.application-question')?.querySelector('label')?.textContent ?? ''
          ).toLowerCase();
          return label.includes('privacy') || label.includes('terms') ||
                 label.includes('consent') || label.includes('agree') || cb.required;
        })
        .map(cb => cb.id)
        .filter(Boolean);
    });

    for (const id of checkboxIds) {
      const el = page.locator(`#${id}`);
      const isChecked = await el.isChecked().catch(() => false);
      if (!isChecked) {
        if (!dryRun) await el.check().catch(() => {});
        const labelText = await page.locator(`label[for="${id}"]`)
          .textContent().catch(() => `Checkbox #${id}`);
        log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Checked consent: "${labelText.trim()}"`);
        filled.push({ label: `Consent: ${labelText.trim()}`, value: 'checked', selector: `#${id}` });
      }
    }
  } catch (err) {
    warnings.push(`Consent checkbox handling failed: ${err.message}`);
  }
}

/**
 * Handle Lever's custom question fields.
 *
 * Lever wraps each custom question in a <div class="application-question"> block.
 * The field name uses the pattern: cards[<uuid>][field<n>]
 *
 * Strategy:
 *   1. Find all .application-question blocks
 *   2. Read the label text
 *   3. Match against fieldAnswers.customAnswers
 *   4. Fill the corresponding input/select/textarea
 */
async function fillCustomQuestions(page, fieldAnswers, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;

  try {
    // Discover all custom question blocks
    const questions = await page.evaluate(() => {
      const HANDLED = [
        'name', 'email', 'phone', 'organization', 'company',
        'linkedin', 'resume', 'cover letter', 'comments',
        'website', 'portfolio', 'github', 'twitter',
      ];

      const blocks = Array.from(document.querySelectorAll('.application-question, [class*="application-question"]'));
      return blocks.map(block => {
        const labelEl = block.querySelector('label');
        const labelText = labelEl?.textContent?.trim().replace(/\s+/g, ' ') ?? '';

        // Get all inputs/textareas/selects inside this block
        const inputs   = Array.from(block.querySelectorAll('input:not([type="hidden"]):not([type="file"])'));
        const textareas = Array.from(block.querySelectorAll('textarea'));
        const selects  = Array.from(block.querySelectorAll('select'));

        const field = inputs[0] ?? textareas[0] ?? selects[0] ?? null;

        return {
          labelText,
          fieldName:  field?.name ?? null,
          fieldId:    field?.id   ?? null,
          fieldTag:   field?.tagName?.toLowerCase() ?? null,
          isHandled:  HANDLED.some(h => labelText.toLowerCase().includes(h)),
        };
      }).filter(q => q.labelText && !q.isHandled && q.fieldName);
    });

    const customAnswers = fieldAnswers.customAnswers ?? {};
    const customKeys    = Object.keys(customAnswers);

    for (const q of questions) {
      const { labelText, fieldName, fieldId, fieldTag } = q;

      // Find best answer match
      const matchKey = customKeys.find(k =>
        labelText.toLowerCase().includes(k.toLowerCase()) ||
        k.toLowerCase().includes(labelText.toLowerCase().replace(/[?*]/g, ''))
      );

      const answer = matchKey ? customAnswers[matchKey] : null;

      if (!answer) {
        skipped.push(`"${labelText}" — no matching answer in report Section H (field: ${fieldName})`);
        continue;
      }

      const selector = fieldId ? `#${fieldId}` : `[name="${fieldName}"]`;

      try {
        const el = page.locator(selector).first();
        const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
        if (!visible) {
          skipped.push(`"${labelText}" — input not visible (${selector})`);
          continue;
        }

        await el.scrollIntoViewIfNeeded();

        if (fieldTag === 'select') {
          // Native select — find best matching option
          const options = await el.locator('option').allTextContents();
          const best = options.find(o => o.toLowerCase().includes(answer.toLowerCase()))
            ?? options.find(o => answer.toLowerCase().includes(o.toLowerCase().trim()));

          if (!best) {
            warnings.push(`"${labelText}" select — no option matching "${truncate(answer, 40)}"`);
            continue;
          }
          if (!dryRun) await el.selectOption({ label: best });
          log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Selected custom "${labelText}": "${best}"`);
          filled.push({ label: labelText, value: best, selector });
        } else {
          // input or textarea
          if (!dryRun) {
            await el.fill('');
            await el.fill(answer);
          }
          log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Filled custom "${labelText}": "${truncate(answer, 60)}"`);
          filled.push({ label: labelText, value: answer, selector });
        }
      } catch (err) {
        warnings.push(`"${labelText}" custom field — ${err.message}`);
      }
    }
  } catch (err) {
    warnings.push(`Custom questions scan failed: ${err.message}`);
  }
}

/**
 * Handle EEOC / EEO questions on Lever forms.
 * Lever puts these in `.eeoc-section` or similar, with <select> dropdowns.
 * Default: "Decline to self-identify" for all.
 */
async function fillEeocSection(page, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  try {
    // Check for an EEOC section
    const hasEeoc = await page.evaluate(() => {
      return !!(
        document.querySelector('.eeoc-section, [class*="eeoc"], [id*="eeoc"]') ||
        (
          document.body.textContent.toLowerCase().includes('equal employment') ||
          document.body.textContent.toLowerCase().includes('voluntary self-identification')
        )
      );
    }).catch(() => false);

    if (!hasEeoc) return;

    log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Processing EEOC section...`);

    const eeocSelects = await page.evaluate(() => {
      const containers = [
        document.querySelector('.eeoc-section'),
        document.querySelector('[class*="eeoc"]'),
        // Fallback: search by section heading
        ...Array.from(document.querySelectorAll('h2, h3, h4, p')).filter(el =>
          el.textContent.toLowerCase().includes('equal employment') ||
          el.textContent.toLowerCase().includes('voluntary self-identification')
        ).map(el => el.closest('section, fieldset, .section') ?? el.parentElement),
      ].filter(Boolean);

      const selects = [];
      for (const container of containers) {
        for (const sel of container.querySelectorAll('select')) {
          const labelEl = sel.closest('.application-question, .field')?.querySelector('label');
          const label = labelEl?.textContent?.trim() ?? sel.name ?? 'unknown';
          const declineOpt = Array.from(sel.options).find(o =>
            o.textContent.toLowerCase().includes('decline') ||
            o.textContent.toLowerCase().includes('prefer not')
          );
          selects.push({ id: sel.id, name: sel.name, label, declineValue: declineOpt?.value ?? null });
        }
      }
      return selects;
    });

    for (const { id, name, label, declineValue } of eeocSelects) {
      if (!declineValue) {
        skipped.push(`EEOC "${label}" — no "Decline" option found`);
        continue;
      }
      const selector = id ? `#${id}` : `[name="${name}"]`;
      if (!dryRun) {
        await page.locator(selector).selectOption({ value: declineValue }).catch(() => {});
      }
      log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} EEOC "${label}": "Decline to self-identify"`);
      filled.push({ label: `EEOC: ${label}`, value: 'Decline to self-identify', selector });
    }
  } catch (err) {
    warnings.push(`EEOC section handling failed: ${err.message}`);
  }
}

// ── Main adapter ──────────────────────────────────────────────────────────────

/**
 * Fill all fields in a Lever application form.
 *
 * @param {import('playwright').Page} page
 * @param {object}  fieldAnswers  Output of buildFieldAnswers()
 * @param {object|boolean} [optionsOrDryRun]  Options object OR boolean dryRun shorthand
 * @returns {Promise<FilledForm>}
 */
export async function fillForm(page, fieldAnswers, optionsOrDryRun = {}) {
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

  log(`${prefix} Starting Lever form fill — ${company} / ${role}`);

  // Wait for the Lever form to be present
  try {
    await page.waitForSelector('form, #application-form, .application-form-section', { timeout: 10_000 });
  } catch {
    warnings.push('Lever form container not detected — page may not have fully loaded');
  }

  // ── Step 1: Full name (Lever uses a single field, not split) ──────────────
  const fullName = `${fieldAnswers.firstName} ${fieldAnswers.lastName}`.trim();
  await fillText(page, 'input[name="name"]', fullName, 'Full Name', ctx);

  // ── Step 2: Email ─────────────────────────────────────────────────────────
  await fillText(page, 'input[name="email"]', fieldAnswers.email, 'Email', ctx);

  // ── Step 3: Phone ─────────────────────────────────────────────────────────
  await fillText(page, 'input[name="phone"]', fieldAnswers.phone, 'Phone', ctx);

  // ── Step 4: Current organization / company ────────────────────────────────
  // Lever has an "org" field for current employer
  const currentOrg = fieldAnswers.currentCompany || '';
  if (currentOrg) {
    await fillText(page, 'input[name="org"]', currentOrg, 'Current Company', ctx);
  } else {
    skipped.push('"Current Company" — not found in profile');
  }

  // ── Step 5: LinkedIn URL ──────────────────────────────────────────────────
  // Lever supports multiple URL fields; LinkedIn is the most common
  const linkedinFilled = await fillText(
    page,
    'input[name="urls[LinkedIn]"]',
    fieldAnswers.linkedin,
    'LinkedIn URL',
    ctx
  );
  if (!linkedinFilled) {
    // Try alternate name attribute format
    await fillText(
      page,
      'input[name="urls[LinkedIn Profile]"]',
      fieldAnswers.linkedin,
      'LinkedIn URL (alternate)',
      ctx
    );
  }

  // ── Step 6: Other URL fields (GitHub, Portfolio) ──────────────────────────
  if (fieldAnswers.github) {
    await fillText(page, 'input[name="urls[GitHub]"]', fieldAnswers.github, 'GitHub URL', ctx);
  }

  if (fieldAnswers.portfolio) {
    const portfolioFilled = await fillText(
      page,
      'input[name="urls[Portfolio]"]',
      fieldAnswers.portfolio,
      'Portfolio URL',
      ctx
    );
    if (!portfolioFilled) {
      await fillText(
        page,
        'input[name="urls[Other]"]',
        fieldAnswers.portfolio,
        'Portfolio URL (Other)',
        ctx
      );
    }
  }

  // ── Step 7: Resume upload ─────────────────────────────────────────────────
  await uploadResume(page, fieldAnswers.resumePath, ctx);

  // ── Step 8: Cover letter / additional information ─────────────────────────
  // Lever's cover letter field is textarea[name="comments"]
  const coverText = fieldAnswers.coverLetter ?? '';
  if (coverText) {
    await fillTextarea(page, 'textarea[name="comments"]', coverText, 'Cover Letter / Comments', ctx);
  } else {
    skipped.push('"Cover Letter" — no cover letter in report Section H');
  }

  // ── Step 9: Native <select> dropdowns ────────────────────────────────────
  // Work authorization — Lever sometimes has this as a custom select
  if (fieldAnswers.workAuthorization) {
    const authSelectors = [
      'select[name*="authorization"]',
      'select[id*="authorization"]',
      'select[name*="work_auth"]',
    ];
    for (const sel of authSelectors) {
      const el = page.locator(sel).first();
      const exists = await el.count().then(n => n > 0).catch(() => false);
      if (exists) {
        await fillSelect(page, sel, 'Work Authorization', fieldAnswers.workAuthorization, ctx);
        break;
      }
    }
  }

  // ── Step 10: Custom application questions ────────────────────────────────
  await fillCustomQuestions(page, fieldAnswers, ctx);

  // ── Step 11: EEOC voluntary demographics ─────────────────────────────────
  await fillEeocSection(page, ctx);

  // ── Step 12: Consent checkboxes ───────────────────────────────────────────
  await checkConsentBoxes(page, ctx);

  const jobUrl = page.url();

  log(`\n${prefix} Lever form fill complete.`);
  log(`  Fields filled:  ${filled.length}`);
  log(`  Fields skipped: ${skipped.length}`);
  log(`  Warnings:       ${warnings.length}`);

  return {
    filled,
    skipped,
    warnings,
    screenshotPath: null,  // caller (index.mjs) takes the screenshot
    ats: 'lever',
    jobUrl,
    company,
    role,
  };
}

/**
 * Submit the Lever form.
 * Clicks the submit button and waits for a confirmation indicator.
 *
 * Lever's submit button is typically `button#btn-submit` or `input[type="submit"]`.
 *
 * @param {import('playwright').Page} page
 * @param {Function} [log]
 * @returns {Promise<{ success: boolean, confirmationText: string }>}
 */
export async function submitForm(page, log = console.log) {
  try {
    const submitBtn = await firstVisible(page, [
      'button#btn-submit',
      'input[type="submit"]',
      'button[type="submit"]',
    ], 5000);

    if (!submitBtn) {
      return { success: false, confirmationText: 'Submit button not found' };
    }

    await submitBtn.scrollIntoViewIfNeeded();
    log('[LIVE] Clicking submit on Lever form...');
    await submitBtn.click();

    // Wait for a confirmation indicator
    try {
      await Promise.race([
        page.waitForURL('**/confirmation**',  { timeout: 15_000 }),
        page.waitForURL('**/thank**',         { timeout: 15_000 }),
        page.waitForURL('**/apply/review**',  { timeout: 15_000 }),
        page.waitForSelector(
          '[class*="confirmation"], [class*="success"], .thank-you, h1:has-text("Thank"), h2:has-text("Application submitted")',
          { timeout: 15_000 }
        ),
      ]);
    } catch {
      const hasSuccessText = await page.evaluate(() => {
        const body = document.body.textContent.toLowerCase();
        return (
          body.includes('thank you') ||
          body.includes('application submitted') ||
          body.includes('application received') ||
          body.includes('your application')
        );
      }).catch(() => false);

      if (!hasSuccessText) {
        const currentUrl = page.url();
        return {
          success: false,
          confirmationText: `Submission may have failed — no confirmation detected. URL: ${currentUrl}`,
        };
      }
    }

    const confirmationText = await page.evaluate(() => {
      return document.querySelector('h1, h2, .thank-you, [class*="confirmation"]')
        ?.textContent?.trim() ?? 'Application submitted';
    }).catch(() => 'Application submitted');

    log(`[LIVE] Lever application submitted. Confirmation: "${confirmationText}"`);
    return { success: true, confirmationText };
  } catch (err) {
    return { success: false, confirmationText: `Submit error: ${err.message}` };
  }
}
