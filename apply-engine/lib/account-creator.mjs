/**
 * apply-engine/lib/account-creator.mjs
 *
 * Handles portal account creation and login with credential persistence.
 * Integrates with credentials.mjs and the universal adapter for form filling.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { storeCredential, getCredential } from './credentials.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..', '..');
const LEARNED_LOGIN_PATH = join(ROOT_DIR, 'data', 'learned-login-forms.json');

// ── Password generator ──────────────────────────────────────────────────────

function generatePassword() {
  const words = ['Cyber', 'Delta', 'Nexus', 'Storm', 'Blade', 'Forge', 'Atlas', 'Nova', 'Volt', 'Echo'];
  const symbols = ['!', '@', '#', '$', '%', '&'];
  const word = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(Math.random() * 900) + 100;
  const sym = symbols[Math.floor(Math.random() * symbols.length)];
  return `${word}${num}${sym}`;
}

// ── Learned login forms store ────────────────────────────────────────────────

function readLearnedLoginForms() {
  if (!existsSync(LEARNED_LOGIN_PATH)) return {};
  try { return JSON.parse(readFileSync(LEARNED_LOGIN_PATH, 'utf8')); }
  catch { return {}; }
}

export async function getLearnedLoginForm(domain) {
  const store = readLearnedLoginForms();
  return store[domain] ?? null;
}

export async function saveLearnedLoginForm(domain, selectors) {
  const store = readLearnedLoginForms();
  store[domain] = { ...selectors, lastUsed: new Date().toISOString().split('T')[0] };
  mkdirSync(dirname(LEARNED_LOGIN_PATH), { recursive: true });
  writeFileSync(LEARNED_LOGIN_PATH, JSON.stringify(store, null, 2), 'utf8');
}

// ── Registration flow ────────────────────────────────────────────────────────

/**
 * Attempt to create an account on a portal for the first time.
 *
 * @param {import('playwright').Page} page
 * @param {string} domain
 * @param {Object} profileData  — from data/profile.json
 * @param {Function} sseEmit    — fn(string) that sends SSE event to frontend
 * @returns {{ username: string, password: string }}
 */
export async function createAccount(page, domain, profileData, sseEmit) {
  const existing = getCredential(domain);
  if (existing) return existing;

  const email = profileData.jobEmail || profileData.email;
  const password = generatePassword();

  sseEmit(`Creating account on ${domain} with ${email}...`);

  // Detect registration link/button
  const regSelectors = [
    'a:has-text("Create Account")',
    'a:has-text("Register")',
    'a:has-text("Sign Up")',
    'a:has-text("Create an Account")',
    'button:has-text("Create Account")',
    'button:has-text("Register")',
    'button:has-text("Sign Up")',
    '[data-testid="register"]',
    '[href*="/register"]',
    '[href*="/signup"]',
    '[href*="/create-account"]',
  ];

  let foundReg = false;
  for (const sel of regSelectors) {
    try {
      const visible = await page.locator(sel).first().isVisible({ timeout: 1500 });
      if (visible) {
        await page.locator(sel).first().click();
        await page.waitForTimeout(1500);
        foundReg = true;
        break;
      }
    } catch {}
  }

  if (!foundReg) {
    sseEmit(`Could not find registration link on ${domain} — manual setup may be needed`);
  }

  // Fill registration form using universal field detection
  const { fillUniversalForm } = await import('../adapters/universal.mjs');
  await fillUniversalForm(page, {
    overrideEmail: email,
    overridePassword: password,
    profileData,
    skipSubmit: true,
  });

  // Store credential
  storeCredential(domain, email, password);
  sseEmit(`Account credentials stored for ${domain}`);

  // Emit pause for email verification
  sseEmit(`PAUSE:verify_email:Check ${email} for a verification email from ${domain}. Click the link, then resume.`);

  return { username: email, password };
}

// ── Login flow ───────────────────────────────────────────────────────────────

/**
 * Log in to a portal using stored credentials.
 * Creates an account if none found.
 *
 * @param {import('playwright').Page} page
 * @param {string} domain
 * @param {Object} profileData
 * @param {Function} sseEmit
 * @returns {boolean} true if logged in successfully
 */
export async function loginToPortal(page, domain, profileData, sseEmit) {
  const cred = getCredential(domain);
  if (!cred) {
    sseEmit(`No saved credentials for ${domain} — attempting account creation...`);
    return createAccount(page, domain, profileData, sseEmit);
  }

  sseEmit(`Logging into ${domain} as ${cred.username}...`);

  // Load learned selectors or use common fallbacks
  const learned = await getLearnedLoginForm(domain);

  const emailSel  = learned?.emailSel  ?? 'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]';
  const passSel   = learned?.passSel   ?? 'input[type="password"]';
  const submitSel = learned?.submitSel ?? 'button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), button:has-text("Login")';

  try {
    await page.locator(emailSel).first().fill(cred.username);
    await page.waitForTimeout(300 + Math.random() * 200);
    await page.locator(passSel).first().fill(cred.password);
    await page.waitForTimeout(300 + Math.random() * 200);
    await page.locator(submitSel).first().click();
    await page.waitForTimeout(2500);
  } catch (e) {
    sseEmit(`Login form interaction failed on ${domain}: ${e.message}`);
    return false;
  }

  // Detect success: login form gone or URL changed
  const stillOnLogin = await page.locator(passSel).first().isVisible({ timeout: 2000 }).catch(() => false);
  if (stillOnLogin) {
    sseEmit(`Login may have failed on ${domain} — check the browser window and continue manually`);
    return false;
  }

  // Save the selectors that worked
  await saveLearnedLoginForm(domain, { emailSel, passSel, submitSel });
  sseEmit(`Successfully logged into ${domain}`);
  return true;
}

// ── Login wall detection ─────────────────────────────────────────────────────

/**
 * Detect if the current page is showing a login wall.
 * @param {import('playwright').Page} page
 * @returns {boolean}
 */
export async function isLoginWall(page) {
  const url = page.url().toLowerCase();
  const loginUrlPatterns = ['/login', '/signin', '/sign-in', '/auth', '/account/login'];
  if (loginUrlPatterns.some(p => url.includes(p))) return true;

  // Check for password field without other content
  const hasPasswordField = await page.locator('input[type="password"]').first().isVisible({ timeout: 2000 }).catch(() => false);
  if (!hasPasswordField) return false;

  // Make sure it's not just a registration page
  const pageText = await page.locator('body').textContent({ timeout: 2000 }).catch(() => '');
  const isLoginPage = /sign\s*in|log\s*in|sign\s*into|log\s*into/i.test(pageText);
  return isLoginPage;
}
