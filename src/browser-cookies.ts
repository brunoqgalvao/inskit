// Reads cookies from the person's everyday browser so the agent's browser starts out logged in.
// macOS: Chromium browsers encrypt cookies with a key in the login Keychain ("<Browser> Safe Storage").
// Reading it shows one macOS prompt; "Always Allow" makes later imports silent.
import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlite } from './sqlite.ts';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type SourceBrowser = { id: string; name: string; root: string; keychain?: string; linuxApp?: string };
export type SourceProfile = { dir: string; name: string; lastUsed: boolean };
export type PlainCookie = {
  name: string; value: string; domain: string; path: string; expires: number;
  httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None';
};

function candidates(): SourceBrowser[] {
  const h = homedir();
  if (platform() === 'darwin') {
    const lib = join(h, 'Library/Application Support');
    return [
      { id: 'chrome', name: 'Google Chrome', root: join(lib, 'Google/Chrome'), keychain: 'Chrome Safe Storage' },
      { id: 'arc', name: 'Arc', root: join(lib, 'Arc/User Data'), keychain: 'Arc Safe Storage' },
      { id: 'brave', name: 'Brave', root: join(lib, 'BraveSoftware/Brave-Browser'), keychain: 'Brave Safe Storage' },
      { id: 'edge', name: 'Microsoft Edge', root: join(lib, 'Microsoft Edge'), keychain: 'Microsoft Edge Safe Storage' },
      { id: 'chromium', name: 'Chromium', root: join(lib, 'Chromium'), keychain: 'Chromium Safe Storage' },
    ];
  }
  if (platform() === 'linux') {
    const cfg = join(h, '.config');
    return [
      { id: 'chrome', name: 'Google Chrome', root: join(cfg, 'google-chrome'), linuxApp: 'chrome' },
      { id: 'chromium', name: 'Chromium', root: join(cfg, 'chromium'), linuxApp: 'chromium' },
      { id: 'chromium', name: 'Chromium (snap)', root: join(h, 'snap/chromium/common/chromium'), linuxApp: 'chromium' },
      { id: 'brave', name: 'Brave', root: join(cfg, 'BraveSoftware/Brave-Browser'), linuxApp: 'brave' },
    ];
  }
  return [];
}

export function detectBrowsers() {
  return candidates().filter(b => existsSync(join(b.root, 'Local State')));
}

export function listProfiles(browser: SourceBrowser): SourceProfile[] {
  try {
    const state = JSON.parse(readFileSync(join(browser.root, 'Local State'), 'utf8'));
    const cache = state?.profile?.info_cache ?? {};
    const last = state?.profile?.last_used ?? 'Default';
    return Object.entries<any>(cache)
      .filter(([dir]) => cookieDb(browser, dir))
      .map(([dir, info]) => ({ dir, name: info?.name || dir, lastUsed: dir === last }));
  } catch {
    return cookieDb(browser, 'Default') ? [{ dir: 'Default', name: 'Default', lastUsed: true }] : [];
  }
}

function cookieDb(browser: SourceBrowser, profile: string) {
  for (const rel of ['Cookies', 'Network/Cookies']) {
    const path = join(browser.root, profile, rel);
    if (existsSync(path)) return path;
  }
  return undefined;
}

export function pickSource(browserId?: string, profile?: string) {
  if (platform() === 'win32') throw new Error('Importing logins from your browser is not supported on Windows yet (Chrome encrypts cookies with app-bound keys there). Log in once in the agent browser window instead.');
  const found = detectBrowsers();
  if (!found.length) throw new Error('No Chromium-based browser found to import logins from (Chrome, Arc, Brave, Edge, Chromium).');
  const browser = browserId ? found.find(b => b.id === browserId || b.name.toLowerCase() === browserId.toLowerCase()) : found[0];
  if (!browser) throw new Error(`Browser "${browserId}" not found. Available: ${found.map(b => b.id).join(', ')}`);
  const profiles = listProfiles(browser);
  const chosen = profile
    ? profiles.find(p => p.dir === profile || p.name.toLowerCase() === profile.toLowerCase())
    : profiles.find(p => p.lastUsed) ?? profiles[0];
  if (!chosen) throw new Error(`Profile "${profile}" not found in ${browser.name}. Profiles: ${profiles.map(p => `${p.name} (${p.dir})`).join(', ')}`);
  return { browser, profile: chosen };
}

const keys = new Map<string, Buffer>();

async function keyFor(browser: SourceBrowser): Promise<{ v10: Buffer; v11?: Buffer }> {
  if (platform() === 'darwin') {
    const cached = keys.get(browser.keychain!);
    if (cached) return { v10: cached };
    let password: string;
    try {
      const { stdout } = await run('security', ['find-generic-password', '-w', '-s', browser.keychain!], { timeout: 120_000 });
      password = stdout.trim();
    } catch {
      throw new Error(`macOS did not release the "${browser.keychain}" key. Click "Always Allow" in the Keychain prompt and try again.`);
    }
    const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    keys.set(browser.keychain!, key);
    return { v10: key };
  }
  // Linux: v10 uses a fixed password; v11 uses the desktop keyring when one is present.
  const v10 = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
  let v11: Buffer | undefined;
  try {
    const { stdout } = await run('secret-tool', ['lookup', 'application', browser.linuxApp ?? 'chrome'], { timeout: 10_000 });
    if (stdout.trim()) v11 = pbkdf2Sync(stdout.trim(), 'saltysalt', 1, 16, 'sha1');
  } catch {}
  return { v10, v11: v11 ?? pbkdf2Sync('', 'saltysalt', 1, 16, 'sha1') };
}

function decrypt(enc: Uint8Array, k: { v10: Buffer; v11?: Buffer }, hashPrefix: boolean) {
  const buf = Buffer.from(enc);
  const tag = buf.subarray(0, 3).toString();
  const key = tag === 'v11' ? k.v11 : tag === 'v10' ? k.v10 : undefined;
  if (!key) return undefined;
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  let out = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
  // DB version 24+ prepends SHA-256(host) to the value.
  if (hashPrefix && out.length >= 32) out = out.subarray(32);
  return out.toString('utf8');
}

const SAME_SITE: Record<string, PlainCookie['sameSite']> = { '0': 'None', '1': 'Lax', '2': 'Strict' };
const EPOCH_DELTA = 11644473600n;

/** Reads (and decrypts) cookies whose host passes the filter. */
export async function readCookies(opts: { browser?: string; profile?: string; hostFilter?: (host: string) => boolean }) {
  const { browser, profile } = pickSource(opts.browser, opts.profile);
  const dbPath = cookieDb(browser, profile.dir)!;
  const dir = mkdtempSync(join(tmpdir(), 'instinct-ck-'));
  try {
    const copy = join(dir, 'Cookies');
    copyFileSync(dbPath, copy);
    for (const ext of ['-wal', '-journal']) if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, copy + ext);
    const db = new (sqlite().DatabaseSync)(copy, { readOnly: true });
    const meta = db.prepare("select value from meta where key = 'version'").get() as { value: string } | undefined;
    const hashPrefix = Number(meta?.value ?? 0) >= 24;
    const stmt = db.prepare('select host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, has_expires, samesite from cookies');
    stmt.setReadBigInts(true);
    const rows = stmt.all() as any[];
    db.close();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const filter = opts.hostFilter ?? (() => true);
    const wanted = rows.filter(r => !r.top_frame_site_key && filter(String(r.host_key).replace(/^\./, '')));
    const key = wanted.some(r => r.encrypted_value?.length) ? await keyFor(browser) : { v10: Buffer.alloc(16) };
    const cookies: PlainCookie[] = [];
    let failed = 0;
    for (const r of wanted) {
      let value: string | undefined = r.value || '';
      if (r.encrypted_value?.length) {
        try { value = decrypt(r.encrypted_value, key, hashPrefix); } catch { value = undefined; }
      }
      if (value === undefined) { failed++; continue; }
      let expires = -1;
      if (Number(r.has_expires) && BigInt(r.expires_utc) > 0n) {
        const secs = BigInt(r.expires_utc) / 1_000_000n - EPOCH_DELTA;
        if (secs < now) continue;
        expires = Number(secs);
      }
      const secure = !!Number(r.is_secure);
      let sameSite = SAME_SITE[String(r.samesite)] ?? 'Lax';
      if (sameSite === 'None' && !secure) sameSite = 'Lax';
      cookies.push({ name: r.name, value, domain: r.host_key, path: r.path || '/', expires, httpOnly: !!Number(r.is_httponly), secure, sameSite });
    }
    return { cookies, failed, browser: browser.name, profile: profile.name };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
