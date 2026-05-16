/**
 * apply-engine/adapters/universal.mjs
 *
 * Universal catch-all adapter for unrecognized ATS portals.
 * Runs when no specific ATS (Greenhouse/Ashby/Lever/Workday/LinkedIn) is detected.
 *
 * Field detection pipeline (runs in order, stops when field is filled):
 *   Layer 1: DOM label matching against KNOWN_FIELD_MAP
 *   Layer 2: data/learned-fields.json lookup
 *   Layer 3: Claude Vision API via /api/vision/analyze-form
 *   Layer 4: SSE pause — "human input needed"
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..', '..');

const PROFILE_PATH        = join(ROOT_DIR, 'data', 'profile.json');
const LEARNED_FIELDS_PATH = join(ROOT_DIR, 'data', 'learned-fields.json');

// ── Profile loader ───────────────────────────────────────────────────────────

export function loadUniversalProfile() {
  if (!existsSync(PROFILE_PATH)) {
    const scaffold = {
      firstName: 'Cole', lastName: 'Charcham',
      email: 'charcham7@gmail.com', jobEmail: '', phone: '',
      city: 'Arlington', state: 'TX', zip: '76010', address: '',
      linkedinUrl: '', githubUrl: '', portfolioUrl: '', websiteUrl: '',
      currentCompany: '', currentTitle: '', yearsExperience: '',
      desiredSalary: '', availableStartDate: 'Immediately',
      workAuthorized: 'Yes', requireSponsorship: 'No',
      veteranStatus: 'I am not a protected veteran',
      disabilityStatus: "I don't wish to answer", coverLetter: '',
    };
    mkdirSync(dirname(PROFILE_PATH), { recursive: true });
    writeFileSync(PROFILE_PATH, JSON.stringify(scaffold, null, 2), 'utf8');
    return scaffold;
  }
  try { return JSON.parse(readFileSync(PROFILE_PATH, 'utf8')); }
  catch { return {}; }
}

// ── Learned fields store ─────────────────────────────────────────────────────

export function readLearnedFields() {
  if (!existsSync(LEARNED_FIELDS_PATH)) return {};
  try { return JSON.parse(readFileSync(LEARNED_FIELDS_PATH, 'utf8')); }
  catch { return {}; }
}

export async function learnField(normalizedLabel, answer, fieldType) {
  const store = readLearnedFields();
  store[normalizedLabel] = {
    answer,
    type: fieldType,
    timesUsed: (store[normalizedLabel]?.timesUsed ?? 0) + 1,
    lastUsed: new Date().toISOString().split('T')[0],
  };
  mkdirSync(dirname(LEARNED_FIELDS_PATH), { recursive: true });
  writeFileSync(LEARNED_FIELDS_PATH, JSON.stringify(store, null, 2), 'utf8');
}

// ── KNOWN_FIELD_MAP ──────────────────────────────────────────────────────────

const KNOWN_FIELD_MAP = {
  'first name': 'profile.firstName',
  'firstname': 'profile.firstName',
  'fname': 'profile.firstName',
  'first': 'profile.firstName',
  'last name': 'profile.lastName',
  'lastname': 'profile.lastName',
  'lname': 'profile.lastName',
  'last': 'profile.lastName',
  'full name': 'profile.fullName',
  'fullname': 'profile.fullName',
  'name': 'profile.fullName',
  'email': 'profile.email',
  'email address': 'profile.email',
  'e-mail': 'profile.email',
  'your email': 'profile.email',
  'phone': 'profile.phone',
  'phone number': 'profile.phone',
  'mobile': 'profile.phone',
  'telephone': 'profile.phone',
  'mobile number': 'profile.phone',
  'city': 'profile.city',
  'location': 'profile.city',
  'state': 'profile.state',
  'state province': 'profile.state',
  'zip': 'profile.zip',
  'zip code': 'profile.zip',
  'postal code': 'profile.zip',
  'address': 'profile.address',
  'street address': 'profile.address',
  'linkedin': 'profile.linkedinUrl',
  'linkedin url': 'profile.linkedinUrl',
  'linkedin profile': 'profile.linkedinUrl',
  'linkedin profile url': 'profile.linkedinUrl',
  'github': 'profile.githubUrl',
  'github url': 'profile.githubUrl',
  'github profile': 'profile.githubUrl',
  'portfolio': 'profile.portfolioUrl',
  'portfolio url': 'profile.portfolioUrl',
  'personal website': 'profile.websiteUrl',
  'website': 'profile.websiteUrl',
  'website url': 'profile.websiteUrl',
  'current company': 'profile.currentCompany',
  'employer': 'profile.currentCompany',
  'current employer': 'profile.currentCompany',
  'company': 'profile.currentCompany',
  'current title': 'profile.currentTitle',
  'current role': 'profile.currentTitle',
  'job title': 'profile.currentTitle',
  'title': 'profile.currentTitle',
  'years of experience': 'profile.yearsExperience',
  'years experience': 'profile.yearsExperience',
  'experience': 'profile.yearsExperience',
  'salary': 'profile.desiredSalary',
  'desired salary': 'profile.desiredSalary',
  'expected salary': 'profile.desiredSalary',
  'salary expectation': 'profile.desiredSalary',
  'compensation': 'profile.desiredSalary',
  'start date': 'profile.availableStartDate',
  'available start date': 'profile.availableStartDate',
  'earliest start date': 'profile.availableStartDate',
  'when can you start': 'profile.availableStartDate',
  'authorized to work': 'profile.workAuthorized',
  'work authorization': 'profile.workAuthorized',
  'legally authorized': 'profile.workAuthorized',
  'require sponsorship': 'profile.requireSponsorship',
  'need sponsorship': 'profile.requireSponsorship',
  'visa sponsorship': 'profile.requireSponsorship',
  'veteran': 'profile.veteranStatus',
  'veteran status': 'profile.veteranStatus',
  'disability': 'profile.disabilityStatus',
  'disability status': 'profile.disabilityStatus',
  'how did you hear': 'learned:how did you hear about us',
  'how did you hear about us': 'learned:how did you hear about us',
  'source': 'learned:how did you hear about us',
  'cover letter': 'profile.coverLetter',
  'resume': 'RESUME_UPLOAD',
  'cv': 'RESUME_UPLOAD',
  'attach resume': 'RESUME_UPLOAD',
  'upload resume': 'RESUME_UPLOAD',
  'upload cv': 'RESUME_UPLOAD',
  'password': 'profile.generatedPassword',
  'confirm password': 'profile.generatedPassword',
  'repeat password': 'profile.generatedPassword',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeLabel(raw) {
  return raw.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function resolveProfileValue(mapping, profileData) {
  if (mapping === 'RESUME_UPLOAD') return null;
  if (mapping.startsWith('learned:')) return null;
  if (!mapping.startsWith('profile.')) return null;
  const field = mapping.slice('profile.'.length);
  if (field === 'fullName') {
    return `${profileData.firstName ?? ''} ${profileData.lastName ?? ''}`.trim();
  }
  return profileData[field] ?? null;
}

async function getElementLabels(page, elementHandle) {
  const labels = [];
  try {
    const ariaLabel = await elementHandle.getAttribute('aria-label');
    if (ariaLabel) labels.push(ariaLabel);
    const placeholder = await elementHandle.getAttribute('placeholder');
    if (placeholder) labels.push(placeholder);
    const name = await elementHandle.getAttribute('name');
    if (name) labels.push(name.replace(/[_-]/g, ' '));
    const id = await elementHandle.getAttribute('id');
    if (id) {
      labels.push(id.replace(/[_-]/g, ' '));
      const labelText = await page.locator(`label[for="${id}"]`).first()
        .textContent({ timeout: 500 }).catch(() => null);
      if (labelText) labels.push(labelText);
    }
    const labelledBy = await elementHandle.getAttribute('aria-labelledby');
    if (labelledBy) {
      for (const ref of labelledBy.split(' ')) {
        const refText = await page.locator(`#${ref}`).first()
          .textContent({ timeout: 500 }).catch(() => null);
        if (refText) labels.push(refText);
      }
    }
    const parentLabel = await elementHandle.evaluate(el => {
      const parent = el.closest('label, .form-group, .field, [class*="field"], [class*="form"]');
      if (!parent) return null;
      const labelEl = parent.querySelector('label, .label, [class*="label"]');
      return labelEl?.textContent?.trim() ?? null;
    });
    if (parentLabel) labels.push(parentLabel);
  } catch {}
  return labels.filter(Boolean);
}

async function humanDelay(min = 80, max = 250) {
  const ms = min + Math.random() * (max - min);
  await new Promise(r => setTimeout(r, ms));
}

async function humanType(page, locator, text) {
  await locator.click({ timeout: 5000 });
  await locator.clear();
  await humanDelay(50, 120);
  for (const char of text) {
    await locator.type(char, { delay: 30 + Math.random() * 60 });
  }
  await humanDelay(100, 300);
}

async function scrollToElement(page, locator) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 3000 });
    await humanDelay(100, 300);
    const box = await locator.boundingBox();
    if (box) {
      await page.mouse.move(
        box.x + box.width / 2 + (Math.random() * 10 - 5),
        box.y + box.height / 2 + (Math.random() * 10 - 5),
        { steps: 5 }
      );
    }
  } catch {}
}

async function fillField(page, locator, value, fieldType) {
  try {
    const tagName = await locator.evaluate(el => el.tagName.toLowerCase());
    const inputType = await locator.getAttribute('type') ?? 'text';
    if (tagName === 'select') {
      try { await locator.selectOption({ label: value }); }
      catch { try { await locator.selectOption({ value }); } catch {} }
      return true;
    }
    if (inputType === 'checkbox') {
      const shouldCheck = /yes|true|1/i.test(value);
      const isChecked = await locator.isChecked();
      if (shouldCheck !== isChecked) await locator.click();
      return true;
    }
    if (inputType === 'radio') return false;
    if (tagName === 'textarea' || ['text', 'email', 'tel', 'url', 'number', 'search'].includes(inputType)) {
      await scrollToElement(page, locator);
      await humanType(page, locator, value);
      return true;
    }
    const isEditable = await locator.evaluate(el => el.isContentEditable);
    if (isEditable) {
      await locator.click();
      await page.keyboard.selectAll();
      await page.keyboard.type(value);
      return true;
    }
  } catch {}
  return false;
}

async function fillRadioGroup(page, groupName, value) {
  const radios = page.locator(`input[type="radio"][name="${groupName}"]`);
  const count = await radios.count();
  for (let i = 0; i < count; i++) {
    const radio = radios.nth(i);
    const radioValue = await radio.getAttribute('value') ?? '';
    const radioId = await radio.getAttribute('id') ?? '';
    const radioLabel = radioId
      ? await page.locator(`label[for="${radioId}"]`).textContent({ timeout: 500 }).catch(() => '')
      : '';
    if (
      radioValue.toLowerCase().includes(value.toLowerCase()) ||
      radioLabel.toLowerCase().includes(value.toLowerCase())
    ) {
      await scrollToElement(page, radio);
      await radio.click();
      await humanDelay(100, 300);
      return true;
    }
  }
  return false;
}

async function callVisionAnalyze(page) {
  try {
    const screenshot = await page.screenshot({ type: 'png' });
    const base64 = screenshot.toString('base64');
    const response = await fetch('http://localhost:7410/api/vision/analyze-form', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screenshot: base64 }),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.mappings ?? [];
  } catch { return []; }
}

// ── OAuth detection ──────────────────────────────────────────────────────────

/**
 * Detect available OAuth / social login options on the current page.
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>}  e.g. ['linkedin', 'google']
 */
export async function detectOAuthOptions(page) {
  const oauthSelectors = [
    {
      type: 'linkedin',
      selectors: [
        '[href*="linkedin.com/oauth"]',
        'button:has-text("LinkedIn")',
        'a:has-text("Apply with LinkedIn")',
        'a:has-text("Sign in with LinkedIn")',
        '[data-provider="linkedin"]',
      ],
    },
    {
      type: 'google',
      selectors: [
        '[href*="accounts.google.com"]',
        'button:has-text("Google")',
        'a:has-text("Sign in with Google")',
        'a:has-text("Continue with Google")',
        '[data-provider="google"]',
      ],
    },
    {
      type: 'indeed',
      selectors: [
        'button:has-text("Indeed")',
        'a:has-text("Apply with Indeed")',
        'a:has-text("Sign in with Indeed")',
        '[data-provider="indeed"]',
      ],
    },
  ];
  const found = [];
  for (const { type, selectors } of oauthSelectors) {
    for (const sel of selectors) {
      try {
        const visible = await page.locator(sel).first().isVisible({ timeout: 1500 });
        if (visible) { found.push(type); break; }
      } catch {}
    }
  }
  return found;
}

// ── Main exports ─────────────────────────────────────────────────────────────

/**
 * Fill all form fields on the current page using the 4-layer detection pipeline.
 *
 * @param {import('playwright').Page} page
 * @param {Object} opts
 * @param {Object}   [opts.profileData]       Override profile data
 * @param {string}   [opts.overrideEmail]     Force a specific email (for registration)
 * @param {string}   [opts.overridePassword]  Force a specific password (for registration)
 * @param {Function} [opts.sseEmit]           SSE event emitter fn(string)
 * @param {boolean}  [opts.skipSubmit]        Do not click submit after filling
 * @param {string}   [opts.resumePath]        Path to resume PDF for file upload fields
 * @returns {Promise<{ filled: string[], skipped: string[], needsHuman: string[] }>}
 */
export async function fillUniversalForm(page, opts = {}) {
  const profileData = { ...( opts.profileData ?? loadUniversalProfile() ) };
  const learnedFields = readLearnedFields();
  const emit = opts.sseEmit ?? ((s) => console.log('[universal]', s));

  if (opts.overrideEmail)    profileData._overrideEmail = opts.overrideEmail;
  if (opts.overridePassword) profileData.generatedPassword = opts.overridePassword;

  const filled     = [];
  const skipped    = [];
  const needsHuman = [];

  const fieldSelectors = [
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
    'textarea',
    'select',
  ].join(', ');

  const allFields = page.locator(fieldSelectors);
  const count = await allFields.count();
  emit(`Found ${count} form fields to process`);

  let visionMappings = null;
  const seenRadioGroups = new Set();

  for (let i = 0; i < count; i++) {
    const field = allFields.nth(i);
    try {
      const isVisible = await field.isVisible({ timeout: 1000 });
      if (!isVisible) continue;
      const isDisabled = await field.isDisabled();
      if (isDisabled) continue;
      const inputType = await field.getAttribute('type') ?? 'text';
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(inputType)) continue;

      // Skip duplicate radio groups
      if (inputType === 'radio') {
        const radioName = await field.getAttribute('name') ?? '';
        if (seenRadioGroups.has(radioName)) continue;
        seenRadioGroups.add(radioName);
      }

      // File upload
      if (inputType === 'file') {
        const rawLabels = await getElementLabels(page, field);
        const normalized = rawLabels.map(normalizeLabel).join(' ');
        if (/resume|cv|upload/i.test(normalized) && opts.resumePath && existsSync(opts.resumePath)) {
          await field.setInputFiles(opts.resumePath);
          filled.push(`Resume upload: ${opts.resumePath}`);
        } else {
          skipped.push(`File upload: ${normalized || 'unknown'}`);
        }
        continue;
      }

      const rawLabels = await getElementLabels(page, field);
      const normalizedLabels = rawLabels.map(normalizeLabel).filter(Boolean);
      if (normalizedLabels.length === 0) { skipped.push(`Unlabeled ${inputType} field`); continue; }
      const primaryLabel = normalizedLabels[0];
      let resolved = false;

      // ── Layer 1: KNOWN_FIELD_MAP ─────────────────────────────────────
      for (const label of normalizedLabels) {
        const mapping = KNOWN_FIELD_MAP[label];
        if (!mapping) continue;
        if (mapping === 'RESUME_UPLOAD') { resolved = true; break; }

        if (mapping.startsWith('learned:')) {
          const learnedKey = mapping.slice('learned:'.length);
          const lf = learnedFields[learnedKey];
          if (lf) {
            const radioName = await field.getAttribute('name') ?? '';
            const ok = inputType === 'radio'
              ? await fillRadioGroup(page, radioName, lf.answer)
              : await fillField(page, field, lf.answer, inputType);
            if (ok) { filled.push(`[L1→L2] ${primaryLabel} = ${lf.answer}`); resolved = true; }
          }
          break;
        }

        let value = resolveProfileValue(mapping, profileData);
        if (mapping === 'profile.email' && opts.overrideEmail) value = opts.overrideEmail;
        if (value !== null && value !== '') {
          const radioName = await field.getAttribute('name') ?? '';
          const ok = inputType === 'radio'
            ? await fillRadioGroup(page, radioName, value)
            : await fillField(page, field, value, inputType);
          if (ok) { filled.push(`[L1] ${primaryLabel} = ${value}`); resolved = true; }
          break;
        }
      }
      if (resolved) { await humanDelay(200, 800); continue; }

      // ── Layer 2: learned-fields.json ─────────────────────────────────
      for (const label of normalizedLabels) {
        const lf = learnedFields[label];
        if (!lf) continue;
        const radioName = await field.getAttribute('name') ?? '';
        const ok = inputType === 'radio'
          ? await fillRadioGroup(page, radioName, lf.answer)
          : await fillField(page, field, lf.answer, inputType);
        if (ok) {
          filled.push(`[L2] ${primaryLabel} = ${lf.answer}`);
          learnField(label, lf.answer, lf.type).catch(() => {});
          resolved = true; break;
        }
      }
      if (resolved) { await humanDelay(200, 800); continue; }

      // ── Layer 3: Claude Vision ────────────────────────────────────────
      if (visionMappings === null) {
        emit('Calling Claude Vision to analyze form fields...');
        visionMappings = await callVisionAnalyze(page);
      }
      for (const label of normalizedLabels) {
        const vm = visionMappings.find(m => normalizeLabel(m.label) === label);
        if (!vm?.value) continue;
        const radioName = await field.getAttribute('name') ?? '';
        const ok = inputType === 'radio'
          ? await fillRadioGroup(page, radioName, vm.value)
          : await fillField(page, field, vm.value, inputType);
        if (ok) {
          filled.push(`[L3] ${primaryLabel} = ${vm.value}`);
          learnField(label, vm.value, inputType).catch(() => {});
          resolved = true; break;
        }
      }
      if (resolved) { await humanDelay(200, 800); continue; }

      // ── Layer 4: Human input ─────────────────────────────────────────
      needsHuman.push(primaryLabel);
      emit(`PAUSE:human_input:${primaryLabel}||${normalizedLabels.join(' / ')}`);
      skipped.push(`[L4:human] ${primaryLabel}`);
      await humanDelay(200, 500);

    } catch (err) {
      skipped.push(`Error on field ${i}: ${err.message}`);
    }
  }

  return { filled, skipped, needsHuman };
}

/**
 * Find and click the submit button on the current form.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ success: boolean, confirmationText: string }>}
 */
export async function submitUniversalForm(page) {
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Apply")',
    'button:has-text("Submit Application")',
    'button:has-text("Send Application")',
    'button:has-text("Apply Now")',
    '[data-testid*="submit"]',
  ];
  for (const sel of submitSelectors) {
    try {
      const btn = page.locator(sel).first();
      const visible = await btn.isVisible({ timeout: 1500 });
      if (!visible) continue;
      const urlBefore = page.url();
      await btn.click();
      await page.waitForTimeout(2500);
      const urlAfter = page.url();
      const pageText = await page.locator('body').textContent({ timeout: 3000 }).catch(() => '');
      const success = urlAfter !== urlBefore ||
        /thank you|application received|successfully submitted|application submitted|we'll be in touch/i.test(pageText);
      return { success, confirmationText: pageText.slice(0, 300).replace(/\s+/g, ' ').trim() };
    } catch {}
  }
  return { success: false, confirmationText: 'Could not find a submit button' };
}
