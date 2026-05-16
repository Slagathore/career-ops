/**
 * apply-engine/adapters/greenhouse.mjs
 *
 * Playwright adapter for Greenhouse ATS forms.
 *
 * Greenhouse powers thousands of company career pages. The form is consistent:
 * - Hosted boards: https://boards.greenhouse.io/{slug}/jobs/{id}
 * - Inline on career page: company page embeds the iframe or posts to Greenhouse
 * - EU boards: https://job-boards.eu.greenhouse.io/{slug}/jobs/{id}
 *
 * Usage:
 *   const result = await fillGreenhouseForm(page, fieldAnswers, { dryRun: true, log });
 *
 * Returns a FilledForm object for dry-run-report.mjs.
 */

// ── Selector constants ────────────────────────────────────────────────────────

const SELECTORS = {
  // Standard Greenhouse input name attributes
  FIRST_NAME:    'input[name="job_application[first_name]"]',
  LAST_NAME:     'input[name="job_application[last_name]"]',
  EMAIL:         'input[name="job_application[email]"]',
  PHONE:         'input[name="job_application[phone]"]',

  // Fallback by id suffix (Greenhouse uses id="first_name", "last_name", etc.)
  FIRST_NAME_ID: 'input#first_name',
  LAST_NAME_ID:  'input#last_name',
  EMAIL_ID:      'input#email',
  PHONE_ID:      'input#phone',

  // Resume upload — Greenhouse uses a hidden file input with id="resume"
  RESUME_FILE:   'input#resume[type="file"], input[type="file"][id*="resume"]',

  // Cover letter textarea
  COVER_LETTER:  'textarea[name="job_application[cover_letter_text]"], textarea[id*="cover_letter"]',

  // Submit button
  SUBMIT:        'input[type="submit"][value*="Submit"], button[type="submit"]',

  // "Apply for this job" button (job listing → form)
  APPLY_BUTTON:  'a[href*="#app"], a#apply_button, .application-button, a:has-text("Apply for this job")',

  // Application form container
  FORM:          '#application_form, form#application, #app',
};

// EEOC section wrapper (Greenhouse puts it in a "voluntary demographics" section)
const EEOC_SECTION = '.eeoc_fields, #demographic_questions, [data-source="eeoc"]';
const EEOC_DECLINE = 'Decline to self-identify';

// ── Greenhouse detection ──────────────────────────────────────────────────────

/**
 * Returns true if the current page appears to be a Greenhouse application form.
 * Checks: URL, page source for known Greenhouse markers, form existence.
 */
export async function isGreenhousePage(page) {
  const url = page.url();
  if (
    url.includes('boards.greenhouse.io') ||
    url.includes('job-boards.greenhouse.io') ||
    url.includes('job-boards.eu.greenhouse.io')
  ) {
    return true;
  }

  // Check for Greenhouse scripts embedded in the page
  const hasGhScript = await page.evaluate(() => {
    return !!(
      document.querySelector('script[src*="greenhouse.io"]') ||
      document.querySelector('[data-source="greenhouse"]') ||
      document.querySelector('#application_form') ||
      document.querySelector('form#application')
    );
  }).catch(() => false);

  return hasGhScript;
}

// ── "Apply" button handler ────────────────────────────────────────────────────

/**
 * If this is a job listing page (not the form yet), click the Apply button.
 * Greenhouse often requires clicking "Apply for this job" to reveal the form
 * or navigate to the application URL.
 */
async function clickApplyIfNeeded(page, log) {
  // If the form is already visible, nothing to do
  const formVisible = await page.locator(SELECTORS.FORM).isVisible().catch(() => false);
  if (formVisible) return;

  // Try to find and click an apply button
  const applyBtn = page.locator(SELECTORS.APPLY_BUTTON).first();
  const exists   = await applyBtn.isVisible({ timeout: 3000 }).catch(() => false);
  if (!exists) return;

  log('Clicking "Apply for this job" button to reveal form...');
  await applyBtn.click();
  // Wait for the form to appear or navigation to complete
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  await page.waitForSelector(SELECTORS.FORM, { timeout: 8_000 }).catch(() => {});
}

// ── Field fill helpers ────────────────────────────────────────────────────────

/**
 * Fill a text input, logging the action.
 * Returns true if successful, false if field not found.
 */
async function fillText(page, selector, value, label, { dryRun, log, filled, skipped, warnings }) {
  if (!value) {
    skipped.push(`"${label}" — no value in profile/report`);
    return false;
  }
  try {
    const el = page.locator(selector).first();
    const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) {
      skipped.push(`"${label}" — field not found on page (${selector})`);
      return false;
    }

    await el.scrollIntoViewIfNeeded();

    if (!dryRun) {
      await el.fill('');          // clear first
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
 * Fill a <textarea> by label text match.
 * Greenhouse custom questions use <label> + associated <textarea>.
 */
async function fillTextareaByLabel(page, labelText, value, { dryRun, log, filled, skipped, warnings }) {
  if (!value) {
    skipped.push(`"${labelText}" textarea — no value available`);
    return false;
  }
  try {
    // Strategy 1: find label whose text includes the search string, then get associated input
    const textarea = await page.evaluate((labelSearch) => {
      const labels = Array.from(document.querySelectorAll('label'));
      const match = labels.find(l => l.textContent.toLowerCase().includes(labelSearch.toLowerCase()));
      if (!match) return null;

      // Use for= attribute to find textarea
      if (match.htmlFor) {
        const el = document.getElementById(match.htmlFor);
        if (el && el.tagName === 'TEXTAREA') return el.id;
      }
      // Look for sibling/child textarea
      const sibling = match.closest('.field, .form-group, .question')?.querySelector('textarea');
      if (sibling) return sibling.id || null;
      return null;
    }, labelText);

    const selector = textarea ? `#${textarea}` : null;

    // Strategy 2: direct selector by name pattern
    const directEl = selector
      ? page.locator(selector).first()
      : page.locator(`textarea`).filter({ hasText: '' }).first();

    const el = selector ? page.locator(selector) : directEl;
    const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) {
      skipped.push(`"${labelText}" textarea — not found`);
      return false;
    }

    await el.scrollIntoViewIfNeeded();
    if (!dryRun) {
      await el.fill('');
      await el.fill(value);
    }

    log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Filled "${labelText}" textarea: "${truncate(value, 60)}"`);
    filled.push({ label: labelText, value, selector: selector ?? 'textarea' });
    return true;
  } catch (err) {
    warnings.push(`"${labelText}" textarea — ${err.message}`);
    return false;
  }
}

/**
 * Upload resume PDF via file input.
 * Playwright's setInputFiles() accepts absolute Windows paths directly.
 */
async function uploadResume(page, resumePath, { dryRun, log, filled, skipped, warnings }) {
  if (!resumePath) {
    skipped.push('"Resume" — no PDF found in output/ directory');
    return false;
  }
  try {
    const fileInput = page.locator(SELECTORS.RESUME_FILE).first();
    const exists = await fileInput.count().then(n => n > 0).catch(() => false);
    if (!exists) {
      // Greenhouse sometimes hides the native file input behind a styled button.
      // Try broader selector.
      const anyFile = page.locator('input[type="file"]').first();
      const anyExists = await anyFile.isVisible({ timeout: 3000 }).catch(() => false);
      if (!anyExists) {
        skipped.push('"Resume" — file input not found');
        return false;
      }
      if (!dryRun) await anyFile.setInputFiles(resumePath);
      log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Uploaded resume: ${resumePath}`);
      filled.push({ label: 'Resume (PDF)', value: resumePath, selector: 'input[type="file"]' });
      return true;
    }

    if (!dryRun) await fileInput.setInputFiles(resumePath);
    log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Uploaded resume: ${resumePath}`);
    filled.push({ label: 'Resume (PDF)', value: resumePath, selector: SELECTORS.RESUME_FILE });
    return true;
  } catch (err) {
    warnings.push(`Resume upload failed: ${err.message}`);
    return false;
  }
}

/**
 * Handle a <select> dropdown by trying to pick the best matching option.
 *
 * @param {Page}   page
 * @param {string} selector  CSS selector for the <select>
 * @param {string} label     Human-readable label
 * @param {string} preferred Preferred value/text to select
 * @param {object} ctx       { dryRun, log, filled, skipped, warnings }
 */
async function fillSelect(page, selector, label, preferred, ctx) {
  const { dryRun, log, filled, skipped, warnings } = ctx;
  if (!preferred) {
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

    // Get available options
    const options = await el.locator('option').allTextContents();
    // Find best match (case-insensitive substring)
    const best = options.find(o => o.toLowerCase().includes(preferred.toLowerCase()))
      ?? options.find(o => preferred.toLowerCase().includes(o.toLowerCase().trim()));

    if (!best) {
      warnings.push(`"${label}" dropdown — no matching option for "${preferred}". Available: ${options.slice(0, 5).join(', ')}`);
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
 * Fill radio button group by label + value text.
 */
async function fillRadio(page, groupLabelText, valueText, { dryRun, log, filled, skipped, warnings }) {
  try {
    // Find all radio inputs near a label matching groupLabelText
    const checked = await page.evaluate(
      ({ groupLabel, value }) => {
        const allLabels = Array.from(document.querySelectorAll('label'));
        const groupEl = allLabels.find(l =>
          l.textContent.toLowerCase().includes(groupLabel.toLowerCase())
        );
        if (!groupEl) return false;

        const container = groupEl.closest('fieldset, .field, .form-group, .question') ?? groupEl.parentElement;
        if (!container) return false;

        const radios = Array.from(container.querySelectorAll('input[type="radio"]'));
        for (const r of radios) {
          const labelEl = document.querySelector(`label[for="${r.id}"]`);
          const text = labelEl?.textContent ?? r.value ?? '';
          if (text.toLowerCase().includes(value.toLowerCase())) {
            r.id && (window.__lastRadioId = r.id);
            return true;
          }
        }
        return false;
      },
      { groupLabel: groupLabelText, value: valueText }
    );

    if (!checked) {
      skipped.push(`"${groupLabelText}" radio — no option matching "${valueText}"`);
      return false;
    }

    const radioId = await page.evaluate(() => window.__lastRadioId);
    if (radioId) {
      const radioEl = page.locator(`#${radioId}`);
      await radioEl.scrollIntoViewIfNeeded();
      if (!dryRun) await radioEl.check();
    }

    log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Checked radio "${groupLabelText}": "${valueText}"`);
    filled.push({ label: groupLabelText, value: valueText, selector: `input[type="radio"]` });
    return true;
  } catch (err) {
    warnings.push(`"${groupLabelText}" radio — ${err.message}`);
    return false;
  }
}

/**
 * Handle all custom question fields on the Greenhouse form.
 * These are the free-text/textarea questions that companies configure themselves.
 *
 * Strategy:
 *   1. Find all <label> elements not already handled (name/email/phone/resume/cover-letter)
 *   2. For each label, find associated textarea or text input
 *   3. Try to match label text against customAnswers keys (fuzzy, case-insensitive)
 *   4. If no match found, skip and warn
 */
async function fillCustomQuestions(page, fieldAnswers, { dryRun, log, filled, skipped, warnings }) {
  try {
    // Grab all visible question labels on the page
    const questionLabels = await page.evaluate(() => {
      const HANDLED = ['first name', 'last name', 'email', 'phone', 'resume', 'cover letter',
        'linkedin', 'website', 'portfolio', 'github'];

      const labels = Array.from(document.querySelectorAll(
        '.field label, .form-group label, .question label, .custom-field label, label.field-label'
      ));

      return labels
        .map(l => ({
          text: l.textContent.trim().replace(/\s+/g, ' '),
          forId: l.htmlFor || null,
        }))
        .filter(({ text }) => {
          const lower = text.toLowerCase();
          return !HANDLED.some(h => lower.includes(h)) && text.length > 2;
        });
    });

    const customAnswers = fieldAnswers.customAnswers ?? {};
    const customKeys    = Object.keys(customAnswers);

    for (const { text: labelText, forId } of questionLabels) {
      // Find best match in customAnswers
      const matchKey = customKeys.find(k =>
        labelText.toLowerCase().includes(k.toLowerCase()) ||
        k.toLowerCase().includes(labelText.toLowerCase().replace(/\?$/, ''))
      );

      const answer = matchKey ? customAnswers[matchKey] : null;

      if (!answer) {
        skipped.push(`"${labelText}" — no matching answer in report Section H`);
        continue;
      }

      // Find the input for this label
      const inputSelector = forId ? `#${forId}` : null;

      if (inputSelector) {
        const isTextarea = await page.locator(inputSelector).evaluate(el => el.tagName === 'TEXTAREA').catch(() => false);
        const isInput    = await page.locator(inputSelector).evaluate(el => el.tagName === 'INPUT').catch(() => false);

        if (isTextarea || isInput) {
          await page.locator(inputSelector).scrollIntoViewIfNeeded().catch(() => {});
          if (!dryRun) {
            await page.locator(inputSelector).fill('');
            await page.locator(inputSelector).fill(answer);
          }
          log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Filled custom question "${labelText}": "${truncate(answer, 60)}"`);
          filled.push({ label: labelText, value: answer, selector: inputSelector });
        }
      } else {
        // Fallback: find textarea in the same container
        await fillTextareaByLabel(page, labelText, answer, { dryRun, log, filled, skipped, warnings });
      }
    }
  } catch (err) {
    warnings.push(`Custom questions scan failed: ${err.message}`);
  }
}

/**
 * Handle EEOC / voluntary demographic questions.
 * Greenhouse groups these in a dedicated section.
 * Default: select "Decline to self-identify" for all dropdowns.
 * If profile has eeoc preferences, use those instead.
 */
async function fillEeocSection(page, profile, { dryRun, log, filled, skipped, warnings }) {
  try {
    const eeocSection = page.locator(EEOC_SECTION).first();
    const eeocVisible = await eeocSection.isVisible({ timeout: 3000 }).catch(() => false);

    if (!eeocVisible) {
      // Also try a more general search for demographic fieldsets
      const hasDemo = await page.evaluate(() =>
        document.body.textContent.toLowerCase().includes('voluntary')
        && document.body.textContent.toLowerCase().includes('equal employment')
      ).catch(() => false);

      if (!hasDemo) return;  // No EEOC section found
    }

    log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Processing EEOC voluntary demographics section...`);

    // Get all selects in the EEOC section
    const eeocSelects = await page.evaluate((declineText) => {
      const containers = [
        document.querySelector('.eeoc_fields'),
        document.querySelector('#demographic_questions'),
        document.querySelector('[data-source="eeoc"]'),
        // Fallback: look for the section by heading text
        ...Array.from(document.querySelectorAll('h2, h3, h4')).filter(h =>
          h.textContent.toLowerCase().includes('equal employment') ||
          h.textContent.toLowerCase().includes('voluntary')
        ).map(h => h.closest('section, .field, fieldset, div') ?? h.nextElementSibling),
      ].filter(Boolean);

      if (containers.length === 0) return [];

      const selects = [];
      for (const container of containers) {
        for (const sel of container.querySelectorAll('select')) {
          const label = sel.closest('.field, .form-group')?.querySelector('label')?.textContent?.trim() ?? sel.name ?? 'unknown';
          // Find "decline" option
          const declineOpt = Array.from(sel.options).find(o =>
            o.textContent.toLowerCase().includes('decline') ||
            o.textContent.toLowerCase().includes('prefer not')
          );
          selects.push({ id: sel.id, label, declineValue: declineOpt?.value ?? null });
        }
      }
      return selects;
    }, EEOC_DECLINE);

    for (const { id, label, declineValue } of eeocSelects) {
      if (!declineValue) {
        skipped.push(`EEOC "${label}" — no "Decline" option found`);
        continue;
      }
      const selector = `#${id}`;
      if (!dryRun) {
        await page.locator(selector).selectOption({ value: declineValue }).catch(() => {});
      }
      log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} EEOC "${label}": "Decline to self-identify"`);
      filled.push({ label: `EEOC: ${label}`, value: EEOC_DECLINE, selector });
    }

    // Also handle radio-button EEOC questions (gender, veteran status, disability)
    const eeocRadioGroups = await page.evaluate(() => {
      const containers = [
        document.querySelector('.eeoc_fields'),
        document.querySelector('#demographic_questions'),
      ].filter(Boolean);

      const groups = [];
      for (const container of containers) {
        const fieldsets = container.querySelectorAll('fieldset');
        for (const fs of fieldsets) {
          const legend = fs.querySelector('legend')?.textContent?.trim() ?? '';
          const declineRadio = Array.from(fs.querySelectorAll('input[type="radio"]')).find(r => {
            const labelEl = document.querySelector(`label[for="${r.id}"]`);
            const text = (labelEl?.textContent ?? r.value ?? '').toLowerCase();
            return text.includes('decline') || text.includes('prefer not');
          });
          if (declineRadio) {
            groups.push({ legend, radioId: declineRadio.id });
          }
        }
      }
      return groups;
    });

    for (const { legend, radioId } of eeocRadioGroups) {
      if (!dryRun) {
        await page.locator(`#${radioId}`).check().catch(() => {});
      }
      log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} EEOC radio "${legend}": "Decline to self-identify"`);
      filled.push({ label: `EEOC: ${legend}`, value: EEOC_DECLINE, selector: `#${radioId}` });
    }
  } catch (err) {
    warnings.push(`EEOC section handling failed: ${err.message}`);
  }
}

/**
 * Check required consent checkboxes (e.g. "I have read and agree to the Privacy Policy").
 */
async function checkConsentBoxes(page, { dryRun, log, filled, warnings }) {
  try {
    const consentCheckboxes = await page.evaluate(() => {
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      return checkboxes
        .filter(cb => {
          const label = document.querySelector(`label[for="${cb.id}"]`)?.textContent?.toLowerCase() ?? '';
          return (
            label.includes('privacy') ||
            label.includes('terms') ||
            label.includes('consent') ||
            label.includes('agree') ||
            cb.required
          );
        })
        .map(cb => cb.id)
        .filter(Boolean);
    });

    for (const id of consentCheckboxes) {
      const el = page.locator(`#${id}`);
      const isChecked = await el.isChecked().catch(() => false);
      if (!isChecked) {
        if (!dryRun) await el.check().catch(() => {});
        const labelText = await page.locator(`label[for="${id}"]`).textContent().catch(() => `Checkbox #${id}`);
        log(`${dryRun ? '[DRY RUN]' : '[LIVE]'} Checked consent: "${labelText.trim()}"`);
        filled.push({ label: `Consent: ${labelText.trim()}`, value: 'checked', selector: `#${id}` });
      }
    }
  } catch (err) {
    warnings.push(`Consent checkbox handling failed: ${err.message}`);
  }
}

// ── Main adapter ──────────────────────────────────────────────────────────────

/**
 * Fill all fields in a Greenhouse application form.
 *
 * @param {import('playwright').Page} page          Playwright page object
 * @param {object}                    fieldAnswers  Output of buildFieldAnswers()
 * @param {object}                    options
 * @param {boolean}                   [options.dryRun=true]    If true, fills but doesn't submit
 * @param {Function}                  [options.log=console.log] Logging function
 * @param {string}                    [options.company]        Company name (for report)
 * @param {string}                    [options.role]           Role title (for report)
 * @returns {Promise<FilledForm>}
 */
export async function fillGreenhouseForm(page, fieldAnswers, options = {}) {
  const {
    dryRun  = true,
    log     = console.log,
    company = fieldAnswers?._report?.company ?? 'Unknown',
    role    = fieldAnswers?._report?.role    ?? 'Unknown',
    profile = fieldAnswers?._profile         ?? {},
  } = options;

  const filled   = [];   // FieldRecord[]
  const skipped  = [];   // string[]
  const warnings = [];   // string[]

  const ctx = { dryRun, log, filled, skipped, warnings };

  const prefix = dryRun ? '[DRY RUN]' : '[LIVE]';
  log(`${prefix} Starting Greenhouse form fill — ${company} / ${role}`);

  // ── Step 0: Click "Apply" if on listing page ───────────────────────────
  await clickApplyIfNeeded(page, log);

  // ── Step 1: Core contact fields ────────────────────────────────────────
  await fillText(page,
    `${SELECTORS.FIRST_NAME}, ${SELECTORS.FIRST_NAME_ID}`,
    fieldAnswers.firstName, 'First Name', ctx
  );

  await fillText(page,
    `${SELECTORS.LAST_NAME}, ${SELECTORS.LAST_NAME_ID}`,
    fieldAnswers.lastName, 'Last Name', ctx
  );

  await fillText(page,
    `${SELECTORS.EMAIL}, ${SELECTORS.EMAIL_ID}`,
    fieldAnswers.email, 'Email', ctx
  );

  await fillText(page,
    `${SELECTORS.PHONE}, ${SELECTORS.PHONE_ID}`,
    fieldAnswers.phone, 'Phone', ctx
  );

  // ── Step 2: Resume upload ──────────────────────────────────────────────
  await uploadResume(page, fieldAnswers.resumePath, ctx);

  // ── Step 3: LinkedIn URL ───────────────────────────────────────────────
  // Greenhouse renders LinkedIn as a custom question with a label containing "LinkedIn"
  if (fieldAnswers.linkedin) {
    const linkedinInput = page.locator(
      'input[id*="linkedin"], input[name*="linkedin"], input[placeholder*="linkedin"], ' +
      'input[placeholder*="LinkedIn"]'
    ).first();
    const liVisible = await linkedinInput.isVisible({ timeout: 3000 }).catch(() => false);
    if (liVisible) {
      await linkedinInput.scrollIntoViewIfNeeded();
      if (!dryRun) {
        await linkedinInput.fill('');
        await linkedinInput.fill(fieldAnswers.linkedin);
      }
      log(`${prefix} Filled "LinkedIn": "${fieldAnswers.linkedin}"`);
      filled.push({ label: 'LinkedIn URL', value: fieldAnswers.linkedin, selector: 'input[id*="linkedin"]' });
    } else {
      // Try label-based approach
      await fillTextareaByLabel(page, 'LinkedIn', fieldAnswers.linkedin, ctx)
        .catch(() => skipped.push('"LinkedIn URL" — field not found'));
    }
  } else {
    skipped.push('"LinkedIn URL" — not in profile');
  }

  // ── Step 4: Portfolio / Website ────────────────────────────────────────
  if (fieldAnswers.portfolio) {
    const portfolioEl = page.locator(
      'input[id*="website"], input[name*="website"], input[id*="portfolio"], ' +
      'input[placeholder*="website"], input[placeholder*="portfolio"]'
    ).first();
    const pVisible = await portfolioEl.isVisible({ timeout: 3000 }).catch(() => false);
    if (pVisible) {
      await portfolioEl.scrollIntoViewIfNeeded();
      if (!dryRun) {
        await portfolioEl.fill('');
        await portfolioEl.fill(fieldAnswers.portfolio);
      }
      log(`${prefix} Filled "Portfolio/Website": "${fieldAnswers.portfolio}"`);
      filled.push({ label: 'Portfolio / Website', value: fieldAnswers.portfolio, selector: 'input[id*="website"]' });
    } else {
      skipped.push('"Portfolio/Website" — field not found on page');
    }
  }

  // ── Step 5: Cover letter ───────────────────────────────────────────────
  if (fieldAnswers.coverLetter) {
    const clEl = page.locator(SELECTORS.COVER_LETTER).first();
    const clVisible = await clEl.isVisible({ timeout: 3000 }).catch(() => false);
    if (clVisible) {
      await clEl.scrollIntoViewIfNeeded();
      if (!dryRun) {
        await clEl.fill('');
        await clEl.fill(fieldAnswers.coverLetter);
      }
      log(`${prefix} Filled "Cover Letter" textarea (${fieldAnswers.coverLetter.length} chars)`);
      filled.push({ label: 'Cover Letter', value: fieldAnswers.coverLetter, selector: SELECTORS.COVER_LETTER });
    } else {
      warnings.push('Cover letter textarea detected pattern not found — cover letter was not filled');
    }
  } else {
    warnings.push('No cover letter in report Section H — cover letter field will be empty');
  }

  // ── Step 6: Work authorization dropdown ───────────────────────────────
  // Greenhouse renders this as a <select> with label "Are you legally authorized..."
  const authSelects = page.locator(
    'select[id*="authorization"], select[name*="authorization"], ' +
    'select[id*="work_auth"]'
  );
  const authCount = await authSelects.count().catch(() => 0);
  if (authCount > 0) {
    await fillSelect(page, 'select[id*="authorization"], select[name*="authorization"]',
      'Work Authorization', fieldAnswers.workAuthorization, ctx
    );
  }

  // ── Step 7: Salary expectation ─────────────────────────────────────────
  if (fieldAnswers.salaryExpectation) {
    const salaryEl = page.locator(
      'input[id*="salary"], input[name*="salary"], input[placeholder*="salary"], ' +
      'input[placeholder*="compensation"], input[placeholder*="expectation"]'
    ).first();
    const salVisible = await salaryEl.isVisible({ timeout: 2000 }).catch(() => false);
    if (salVisible) {
      await salaryEl.scrollIntoViewIfNeeded();
      if (!dryRun) {
        await salaryEl.fill('');
        await salaryEl.fill(fieldAnswers.salaryExpectation);
      }
      log(`${prefix} Filled "Salary Expectation": "${fieldAnswers.salaryExpectation}"`);
      filled.push({ label: 'Salary Expectation', value: fieldAnswers.salaryExpectation, selector: 'input[id*="salary"]' });
    }
    // Salary is often not present — silently skip if not found
  }

  // ── Step 8: Custom questions (Section H answers) ───────────────────────
  await fillCustomQuestions(page, fieldAnswers, ctx);

  // ── Step 9: EEOC voluntary demographics ───────────────────────────────
  await fillEeocSection(page, profile, ctx);

  // ── Step 10: Consent checkboxes ────────────────────────────────────────
  await checkConsentBoxes(page, ctx);

  // ── Done: return result (adapter NEVER clicks Submit) ──────────────────
  const jobUrl       = page.url();
  const screenshotPath = null;  // caller (index.mjs) takes the screenshot

  log(`\n${prefix} Form fill complete.`);
  log(`  Fields filled:  ${filled.length}`);
  log(`  Fields skipped: ${skipped.length}`);
  log(`  Warnings:       ${warnings.length}`);

  return {
    filled,
    skipped,
    warnings,
    screenshotPath,
    ats: 'greenhouse',
    jobUrl,
    company,
    role,
  };
}

/**
 * Submit the Greenhouse form. Only called from index.mjs after human confirmation.
 * Waits for the confirmation page or success message.
 *
 * @param {import('playwright').Page} page
 * @param {Function} log
 * @returns {Promise<{ success: boolean, confirmationUrl: string|null, message: string }>}
 */
export async function submitGreenhouseForm(page, log = console.log) {
  try {
    const submitBtn = page.locator(SELECTORS.SUBMIT).first();
    const exists = await submitBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (!exists) {
      return { success: false, confirmationUrl: null, message: 'Submit button not found' };
    }

    await submitBtn.scrollIntoViewIfNeeded();
    log('[LIVE] Clicking Submit...');
    await submitBtn.click();

    // Wait for navigation to confirmation page OR success message appearing on page
    try {
      await Promise.race([
        page.waitForURL('**/confirmation**', { timeout: 15_000 }),
        page.waitForURL('**/thank**',        { timeout: 15_000 }),
        page.waitForSelector('.application-confirmation, .success-message, h1:has-text("Thank")', { timeout: 15_000 }),
      ]);
    } catch {
      // If nothing matched, check if URL changed at all
      const newUrl = page.url();
      const hasSuccessText = await page.evaluate(() =>
        document.body.textContent.toLowerCase().includes('thank you') ||
        document.body.textContent.toLowerCase().includes('application') &&
        document.body.textContent.toLowerCase().includes('received')
      ).catch(() => false);

      if (!hasSuccessText) {
        return { success: false, confirmationUrl: newUrl, message: 'Submission may have failed — no confirmation page detected' };
      }
    }

    const confirmationUrl = page.url();
    log(`[LIVE] Application submitted. Confirmation URL: ${confirmationUrl}`);
    return { success: true, confirmationUrl, message: 'Application submitted successfully' };
  } catch (err) {
    return { success: false, confirmationUrl: null, message: `Submit error: ${err.message}` };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncate(s, max) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
