/**
 * apply-engine/lib/gmail-verifier.mjs
 *
 * Gmail API verifier — scaffold for auto-fetching verification emails.
 * Requires data/.gmail-token.json (set up via webui Settings → Gmail Connect).
 *
 * When token exists: polls inbox for verification emails from a given domain,
 *   extracts the verification link, navigates to it.
 * When token missing: falls back to manual pause / SSE notification.
 *
 * TODO: implement Gmail API polling once OAuth token flow is wired up in Settings UI.
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..', '..');
const TOKEN_PATH = join(ROOT_DIR, 'data', '.gmail-token.json');

/**
 * Attempt to auto-verify an email from fromDomain by polling Gmail.
 *
 * @param {import('playwright').Page} page       Playwright page (to navigate to verify link)
 * @param {string}                    fromDomain  Domain to look for in sender address
 * @param {number}                    timeoutMs   How long to wait for the email (default 2 min)
 * @returns {{ method: 'auto'|'manual', message: string, link?: string }}
 */
export async function autoVerifyEmail(page, fromDomain, timeoutMs = 120_000) {
  if (!existsSync(TOKEN_PATH)) {
    return {
      method: 'manual',
      message: `Check your job email for a verification link from ${fromDomain}. ` +
               `Connect Gmail in Settings to enable auto-verification.`,
    };
  }

  // Token exists — placeholder for Gmail API polling
  // Real implementation:
  // 1. Load token from TOKEN_PATH
  // 2. Call Gmail API: GET /gmail/v1/users/me/messages?q=from:${fromDomain}&newer_than:2m
  // 3. Get message body, extract verification URL via regex
  // 4. await page.goto(verifyUrl)
  // 5. Return { method: 'auto', link: verifyUrl }
  //
  // For now, always falls back to manual until OAuth is implemented:
  return {
    method: 'manual',
    message: `Check your job email for a verification link from ${fromDomain}.`,
  };
}

/**
 * Check if Gmail is connected (token file exists and has an access_token).
 * @returns {{ connected: boolean, email: string }}
 */
export function getGmailStatus() {
  if (!existsSync(TOKEN_PATH)) {
    return { connected: false, email: '' };
  }
  try {
    const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
    return {
      connected: !!(token.access_token || token.refresh_token),
      email: token.email ?? '',
    };
  } catch {
    return { connected: false, email: '' };
  }
}
