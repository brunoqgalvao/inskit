import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { BRAND } from './brand.ts';

export type Config = {
  home: string;
  port: number;
  host: string;
  /** Base URL the human uses to open vault and approval pages. */
  publicUrl: string;
  /** Attach to an existing browser over CDP (e.g. the VM's headless Chromium) instead of launching one. */
  cdpUrl?: string;
  /**
   * Cloud browser: your own Browser Use key, a Superpowers account (the service keeps the key and your profile and bills
   * the account), or the free hosted service (hostedUrl) when there is neither.
   */
  browserUse?: { apiKey?: string; hostedUrl?: string; superpowers?: { url: string; apiKey: string }; proxyCountry: string; timeoutMinutes: number };
  headless: boolean;
  channel?: string;
  executablePath?: string;
  /** Open vault/approval links in the human's default browser automatically (Mac). */
  openLinks: boolean;
  /** Chrome profile directory to read cookies from ("Default", "Profile 2"...). */
  chromeProfile?: string;
  /** Import a site's cookies from the human's Chrome the first time the agent visits it. */
  cookieSync: boolean;
  downloadsDir: string;
  browserIdleMinutes: number;
  /** How purchase approval is asked when Codex shows no native prompt: in the chat (default) or on a local page. */
  approval: 'chat' | 'page';
};

export function expandHome(path: string) {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** Default home of the free hosted cloud browser service. */
export const HOSTED_URL = 'https://inskit.justmade.page';
/** Superpowers: paid cloud browsers billed to your account, plus its other tools. */
export const SUPERPOWERS_URL = 'https://superpowers.tools';
/** Written by `inskit superpowers login` (0600). Only this file or INSKIT_SUPERPOWERS_API_KEY switches the browser to Superpowers. */
export const superpowersKeyFile = (home: string) => join(home, 'superpowers.key');

/**
 * Settings file for people who cannot set environment variables (the Codex app): <home>/config.json holds the
 * same names as the environment, e.g. {"INSTINCT_BROWSER_PROVIDER": "local"}. The environment wins.
 */
export function applyConfigFile(env: NodeJS.ProcessEnv = process.env) {
  const home = expandHome(env.INSTINCT_HOME || '~/.instinct');
  const file = join(home, 'config.json');
  if (!existsSync(file)) return;
  try {
    const values = JSON.parse(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!/^(INSTINCT|INSKIT)_[A-Z_]+$|^BROWSER_USE_API_KEY$|^ANTHROPIC_API_KEY$/.test(key)) continue;
      if (env[key] === undefined && value !== null && value !== undefined) env[key] = String(value);
    }
  } catch { /* A broken settings file must not stop the plugin; defaults apply. */ }
}

export function loadConfig(): Config {
  applyConfigFile();
  const env = process.env;
  const mac = platform() === 'darwin';
  const port = Number(env.INSTINCT_PORT || 17700);
  const publicUrl = (env.INSTINCT_PUBLIC_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  const cdpUrl = env.INSTINCT_CDP_URL || undefined;
  const home = expandHome(env.INSTINCT_HOME || '~/.instinct');
  const keyFile = expandHome(env.INSTINCT_BROWSER_USE_KEY_FILE || join(home, 'browser-use.key'));
  const apiKey = env.BROWSER_USE_API_KEY || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '');
  const hostedUrl = env.INSTINCT_HOSTED_URL === '0' ? '' : (env.INSTINCT_HOSTED_URL || HOSTED_URL).replace(/\/+$/, '');
  // A SUPERPOWERS_API_KEY set for other tools must not move the browser onto a paid account; only an explicit sign-in does.
  const spFile = superpowersKeyFile(home);
  const spKey = env.INSKIT_SUPERPOWERS_API_KEY || (existsSync(spFile) ? readFileSync(spFile, 'utf8').trim() : '');
  const spUrl = (env.INSKIT_SUPERPOWERS_URL || SUPERPOWERS_URL).replace(/\/+$/, '');
  const provider = env.INSTINCT_BROWSER_PROVIDER || (cdpUrl ? 'cdp' : apiKey ? 'browser-use' : spKey ? 'superpowers' : hostedUrl ? 'hosted' : 'local');
  if (!['local', 'cdp', 'browser-use', 'superpowers', 'hosted'].includes(provider)) throw new Error('Unknown INSTINCT_BROWSER_PROVIDER. Use hosted, superpowers, browser-use, local or cdp.');
  if (provider === 'browser-use' && !apiKey) throw new Error('Browser Use Cloud requires BROWSER_USE_API_KEY or a browser-use.key file.');
  if (provider === 'superpowers' && !spKey) throw new Error('The Superpowers browser needs a sign-in: run inskit superpowers login.');
  if (provider === 'hosted' && !hostedUrl) throw new Error('The hosted provider needs INSTINCT_HOSTED_URL.');
  if (provider === 'cdp' && !cdpUrl) throw new Error('The cdp provider requires INSTINCT_CDP_URL.');
  const proxyCountry = env.INSTINCT_PROXY_COUNTRY || 'br';
  const browserUse = provider === 'browser-use' ? { apiKey, proxyCountry, timeoutMinutes: 60 }
    : provider === 'superpowers' ? { superpowers: { url: spUrl, apiKey: spKey }, proxyCountry, timeoutMinutes: 30 }
    : provider === 'hosted' ? { hostedUrl, proxyCountry, timeoutMinutes: 30 }
    : undefined;
  return {
    home,
    port,
    host: env.INSTINCT_HOST || '127.0.0.1',
    publicUrl,
    cdpUrl: provider === 'cdp' ? cdpUrl : undefined,
    browserUse,
    headless: env.INSTINCT_HEADLESS === '1',
    channel: env.INSTINCT_BROWSER_CHANNEL === 'chromium' ? undefined : (env.INSTINCT_BROWSER_CHANNEL || (mac ? 'chrome' : undefined)),
    executablePath: env.INSTINCT_CHROME_PATH || undefined,
    openLinks: env.INSTINCT_OPEN_LINKS ? env.INSTINCT_OPEN_LINKS === '1' : mac && /\/\/(127\.0\.0\.1|localhost)[:/]/.test(publicUrl + '/'),
    chromeProfile: env.INSTINCT_CHROME_PROFILE || undefined,
    cookieSync: env.INSTINCT_COOKIE_SYNC ? env.INSTINCT_COOKIE_SYNC !== '0' : mac && provider === 'local',
    // Existing installs keep their folder; new ones get one named after the plugin.
    downloadsDir: expandHome(env.INSTINCT_DOWNLOADS || (existsSync(expandHome('~/Downloads/Instinct')) ? '~/Downloads/Instinct' : '~/Downloads/' + BRAND)),
    browserIdleMinutes: Number(env.INSTINCT_BROWSER_IDLE_MIN || (browserUse ? 5 : 45)),
    approval: env.INSTINCT_APPROVAL === 'page' ? 'page' : 'chat',
  };
}
