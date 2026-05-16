/**
 * apply-engine/lib/credentials.mjs
 *
 * Windows Credential Manager integration for storing/retrieving portal login credentials.
 * Falls back to AES-encrypted JSON if the CredentialManager PowerShell module is unavailable.
 */

import { execSync, execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..', '..');
const CRED_FILE = join(ROOT_DIR, 'data', '.credentials.enc');

const TARGET_PREFIX = 'career-ops:';

// Derive a deterministic AES-256 key from machine hostname (fallback only)
function getFallbackKey() {
  const hostname = os.hostname();
  return crypto.createHash('sha256').update(`career-ops:${hostname}`).digest();
}

function encryptFallback(text) {
  const key = getFallbackKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptFallback(encText) {
  const [ivHex, encHex] = encText.split(':');
  const key = getFallbackKey();
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function readFallbackStore() {
  if (!existsSync(CRED_FILE)) return {};
  try {
    const raw = readFileSync(CRED_FILE, 'utf8').trim();
    const decrypted = decryptFallback(raw);
    return JSON.parse(decrypted);
  } catch { return {}; }
}

function writeFallbackStore(store) {
  mkdirSync(dirname(CRED_FILE), { recursive: true });
  const encrypted = encryptFallback(JSON.stringify(store));
  writeFileSync(CRED_FILE, encrypted, 'utf8');
}

/** Check whether CredentialManager module is available */
let _hasCredModule = null;
function hasCredentialManagerModule() {
  if (_hasCredModule !== null) return _hasCredModule;
  try {
    execSync(
      'powershell -Command "if (Get-Command Get-StoredCredential -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"',
      { encoding: 'utf8', stdio: 'pipe' }
    );
    _hasCredModule = true;
  } catch {
    _hasCredModule = false;
  }
  return _hasCredModule;
}

/**
 * Store a credential for a domain.
 * @param {string} domain  e.g. "myworkdayjobs.com"
 * @param {string} username
 * @param {string} password
 */
export function storeCredential(domain, username, password) {
  if (hasCredentialManagerModule()) {
    try {
      execSync(
        `cmdkey /add:"${TARGET_PREFIX}${domain}" /user:"${username}" /pass:"${password}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
      return;
    } catch (e) {
      console.warn(`[creds] cmdkey failed: ${e.message} — using encrypted fallback`);
    }
  }
  // Fallback: encrypted file
  const store = readFallbackStore();
  store[domain] = { username, password };
  writeFallbackStore(store);
}

/**
 * Retrieve a credential for a domain.
 * @param {string} domain
 * @returns {{ username: string, password: string } | null}
 */
export function getCredential(domain) {
  if (hasCredentialManagerModule()) {
    try {
      const result = execSync(
        `powershell -Command "` +
        `$cred = Get-StoredCredential -Target '${TARGET_PREFIX}${domain}' -ErrorAction SilentlyContinue; ` +
        `if ($cred) { Write-Output ($cred.UserName + '|' + [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($cred.Password))) }"`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();
      if (!result || !result.includes('|')) return null;
      const [username, password] = result.split('|');
      return { username, password };
    } catch {
      // Fall through to fallback
    }
  }
  const store = readFallbackStore();
  return store[domain] ?? null;
}

/**
 * Delete a credential for a domain.
 * @param {string} domain
 */
export function deleteCredential(domain) {
  if (hasCredentialManagerModule()) {
    try {
      execSync(`cmdkey /delete:"${TARGET_PREFIX}${domain}"`, { stdio: 'pipe' });
    } catch {}
  }
  const store = readFallbackStore();
  delete store[domain];
  writeFallbackStore(store);
}

/**
 * List all domains we have credentials for.
 * @returns {string[]}
 */
export function listCredentials() {
  const domains = new Set();

  // From Windows Credential Manager
  if (hasCredentialManagerModule()) {
    try {
      const result = execSync(
        `powershell -Command "cmdkey /list | Select-String '${TARGET_PREFIX}'"`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
      for (const line of result.split('\n')) {
        const m = line.match(/career-ops:(.+)/);
        if (m) domains.add(m[1].trim());
      }
    } catch {}
  }

  // From fallback file
  const store = readFallbackStore();
  for (const domain of Object.keys(store)) {
    domains.add(domain);
  }

  return [...domains];
}
