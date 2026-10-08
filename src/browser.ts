import { chromium, type Browser as PwBrowser, type BrowserContext, type Frame, type Locator, type Page } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Config } from './config.ts';
import { containsCardNumber, Redactor } from './redact.ts';
import type { PlainCookie } from './browser-cookies.ts';
import { BrowserUseCloud } from './browser-use.ts';
import { classifySource, cookiesSource, methodSource, scanSource, type PageClass, type ScanOptions } from './login/page-scripts.ts';
import type { LoginPlan } from './login/recipes.ts';

const PURCHASE_BUTTON = /(finalizar|concluir|confirmar|fechar|efetuar|realizar)\s+(a\s+|o\s+|minha\s+|meu\s+)?(compra|pedido|pagamento)|\bpagar\b|comprar\s+agora|fazer\s+(o\s+)?pedido|place\s+(your\s+)?order|pay\s+now|buy\s+now|complete\s+(purchase|order|payment)|confirm\s+(and\s+pay|order|purchase|payment)|submit\s+(order|payment)|^\s*pay\s+[$€£R]|^\s*pay\s*$|book\s+now|reserve\s+now|confirmar\s+reserva|jetzt\s+kaufen|zahlungspflichtig|comprar\s+ya|pagar\s+ahora/i;

export function isPurchaseButton(name: string) {
  return PURCHASE_BUTTON.test(name.replace(/\s+/g, ' ').trim());
}

const MAC_FALLBACKS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const LINUX_FALLBACKS = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/brave-browser'];

export type Download = { file: string; url: string; at: number };
export type LoginOutcome = 'logged_in' | 'code_requested' | 'method_choice' | 'needs_human' | 'rejected' | 'no_login_form' | 'no_response' | 'left_site' | 'no_submit_button' | 'form_extras' | 'blocked' | 'error';
export type AutoLoginResult = { outcome: LoginOutcome; steps: string[]; alert?: string; reason?: string; ms: number; passwordSent: boolean; method: string };

type LoginScan = { frame: Frame; password: boolean; passwordEmpty: boolean; username: boolean; usernameEmpty: boolean;
  submit: string; submitEnabled: boolean; codeFields: number; codeEnabled: boolean; invalid: boolean; alert: string; extras: number };



export class AgentBrowser {
  private browser?: PwBrowser;
  private context?: BrowserContext;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private cloud?: BrowserUseCloud;
  liveUrl?: string;
  /** Each Codex chat drives its own tab. */
  private pages = new Map<string, Page>();
  private secretFieldRefs = new WeakMap<Page, Set<string>>();
  private secretPages = new WeakMap<Page, string>();
  /** Pages where a one-time code was typed into one-character boxes. */
  private codePages = new WeakMap<Page, string>();
  /** Recipe selectors and learned names in effect for a page's login scan. */
  private scanOptions = new WeakMap<Page, ScanOptions>();
  private idleTimer?: NodeJS.Timeout;
  readonly redactor = new Redactor();
  readonly downloads: Download[] = [];
  lastUsed = Date.now();
  /** Called before navigating, e.g. to import that site's logins. Returns a note for the agent. */
  beforeNavigate?: (url: string) => Promise<string | undefined>;

  constructor(private cfg: Config) {
    if (cfg.browserUse) this.cloud = new BrowserUseCloud(cfg);
  }

  get running() { return !!this.context; }
  get mode() { return this.cloud ? (this.cloud.hosted ? 'Browser Use Cloud, free hosted' : 'Browser Use Cloud') : this.cfg.cdpUrl ? 'remote CDP' : this.cfg.headless ? 'headless' : 'window'; }

  async start() {
    if (this.closing) await this.closing;
    if (this.context) return;
    this.starting ??= this.launch().finally(() => { this.starting = undefined; });
    await this.starting;
  }

  private async launch() {
    let context: BrowserContext;
    if (this.cloud) {
      const remote = await this.cloud.start();
      try {
        this.browser = await chromium.connectOverCDP(remote.cdpUrl, { timeout: 30_000 });
        context = this.browser.contexts()[0];
        if (!context) throw new Error('No managed browser context.');
        this.liveUrl = remote.liveUrl;
        this.browser.on('disconnected', () => { if (!this.closing) void this.close().catch(() => {}); });
      } catch {
        await this.close();
        throw new Error('Could not connect to Browser Use Cloud. No local browser was launched.');
      }
    } else if (this.cfg.cdpUrl) {
      this.browser = await chromium.connectOverCDP(this.cfg.cdpUrl, { timeout: 20_000 });
      context = this.browser.contexts()[0] ?? (await this.browser.newContext());
      this.browser.on('disconnected', () => this.reset());
    } else {
      const profile = join(this.cfg.home, 'browser-profile');
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      const args = ['--disable-blink-features=AutomationControlled', '--window-size=1280,900', '--no-first-run', '--no-default-browser-check'];
      if (process.env.INSTINCT_DEBUG_PORT) args.push(`--remote-debugging-port=${process.env.INSTINCT_DEBUG_PORT}`);
      const base = {
        headless: this.cfg.headless, viewport: null, args, acceptDownloads: true,
        ignoreDefaultArgs: ['--enable-automation'],
      };
      const attempts: { channel?: string; executablePath?: string }[] = [];
      if (this.cfg.executablePath) attempts.push({ executablePath: this.cfg.executablePath });
      if (this.cfg.channel) attempts.push({ channel: this.cfg.channel });
      for (const p of process.platform === 'darwin' ? MAC_FALLBACKS : LINUX_FALLBACKS) if (existsSync(p)) attempts.push({ executablePath: p });
      let lastError: unknown;
      let launched: BrowserContext | undefined;
      for (const attempt of attempts) {
        try { launched = await chromium.launchPersistentContext(profile, { ...base, ...attempt }); break; }
        catch (error) {
          lastError = error;
          if (/ProcessSingleton|profile.*in use|SingletonLock/i.test(String(error))) throw new Error('The agent browser profile is already open in another process. Close that window and retry.');
        }
      }
      if (!launched) throw new Error(`Could not start a browser. Install Google Chrome (or set INSTINCT_CHROME_PATH). Last error: ${String(lastError).split('\n')[0]}`);
      context = launched;
    }
    this.context = context;
    context.on('close', () => this.reset());
    context.on('page', page => void this.adopt(page));
    for (const page of context.pages()) this.watchDownloads(page);
    this.idleTimer = setInterval(() => {
      if (!this.cfg.cdpUrl && Date.now() - this.lastUsed > this.cfg.browserIdleMinutes * 60_000) void this.close().catch(() => {});
    }, 60_000);
    this.idleTimer.unref();
  }

  private reset() {
    this.context = undefined;
    this.browser = undefined;
    this.pages.clear();
    this.liveUrl = undefined;
    if (this.idleTimer) clearInterval(this.idleTimer);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const ctx = this.context, browser = this.browser;
    this.closing = (async () => {
      this.reset();
      try {
        if (this.cfg.cdpUrl || this.cloud) await browser?.close().catch(() => {});
        else await ctx?.close().catch(() => {});
      } finally { await this.cloud?.stop(); }
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  /** Popups opened from a session's tab become that session's current tab. */
  private async adopt(page: Page) {
    this.watchDownloads(page);
    const opener = await page.opener().catch(() => null);
    if (!opener) return;
    for (const [session, p] of this.pages) if (p === opener) this.pages.set(session, page);
  }

  private watchDownloads(page: Page) {
    page.on('download', async download => {
      try {
        mkdirSync(this.cfg.downloadsDir, { recursive: true });
        let file = join(this.cfg.downloadsDir, basename(download.suggestedFilename() || 'download'));
        if (existsSync(file)) file = file.replace(/(\.[^.]*)?$/, m => `-${Date.now()}${m}`);
        await download.saveAs(file);
        this.downloads.unshift({ file, url: download.url(), at: Date.now() });
        this.downloads.splice(30);
      } catch {}
    });
  }

  async page(session: string) {
    this.lastUsed = Date.now();
    await this.start();
    const current = this.pages.get(session);
    if (current && !current.isClosed()) return current;
    const claimed = new Set(this.pages.values());
    const blank = this.context!.pages().find(p => !p.isClosed() && !claimed.has(p) && /^(about:blank|chrome:\/\/new-tab-page|chrome:\/\/newtab)/.test(p.url()));
    const page = blank ?? (await this.context!.newPage());
    this.pages.set(session, page);
    return page;
  }

  async addCookies(cookies: PlainCookie[]) {
    await this.start();
    let added = 0;
    // One bad cookie makes the whole batch fail, so fall back to one by one.
    for (let i = 0; i < cookies.length; i += 200) {
      const batch = cookies.slice(i, i + 200);
      try { await this.context!.addCookies(batch); added += batch.length; }
      catch { for (const c of batch) { try { await this.context!.addCookies([c]); added++; } catch {} } }
    }
    return added;
  }

  private async settle(page: Page) {
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(600);
    const marked = this.secretPages.get(page);
    if (marked && marked !== page.url()) this.secretPages.delete(page);
  }

  private locate(page: Page, ref: string): Locator {
    if (!/^(f\d+)?e\d+$/.test(ref)) throw new Error(`Invalid ref "${ref}". Use a ref from the snapshot, e.g. e12 or f1e3.`);
    return page.locator(`aria-ref=${ref}`);
  }

  private async nameOf(locator: Locator) {
    return locator.evaluate((el: any) => {
      const text = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || '').trim();
      return text.slice(0, 200);
    }).catch(() => '');
  }

  private redactSnapshot(page: Page, tree: string) {
    const refs = this.secretFieldRefs.get(page);
    const masked = tree.split('\n').map(line => {
      const ref = line.match(/\[ref=([^\]]+)\]/)?.[1];
      return ref && refs?.has(ref) ? line.replace(/(\[ref=[^\]]+\][^:\n]*):.*$/, '$1: [hidden by vault]') : line;
    }).join('\n');
    const codeUrl = this.codePages.get(page);
    const boxes = codeUrl && codeUrl === page.url()
      ? masked.replace(/^(\s*- textbox[^\n]*\[ref=[^\]]+\][^:\n]*): .{1,2}$/gm, '$1: [hidden by vault]')
      : masked;
    return this.redactor.redact(boxes);
  }

  async snapshot(session: string, maxChars = 14_000) {
    const page = await this.page(session);
    let tree: string;
    try { tree = await page.ariaSnapshot({ mode: 'ai', timeout: 20_000 } as any); }
    catch (error) { tree = `(snapshot failed: ${error instanceof Error ? error.message.split('\n')[0] : error})`; }
    const header = `URL: ${page.url()}\nTitle: ${await page.title().catch(() => '')}\n`;
    const body = this.redactSnapshot(page, tree);
    if (body.length <= maxChars) return header + body;
    return header + body.slice(0, maxChars) + `\n… (snapshot cut at ${maxChars} of ${body.length} chars; use browser_find to locate elements or a larger max_chars)`;
  }

  async find(session: string, query: string, context = 2) {
    const page = await this.page(session);
    const tree = this.redactSnapshot(page, await page.ariaSnapshot({ mode: 'ai', timeout: 20_000 } as any));
    const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const terms = norm(query).split(/\s+/).filter(Boolean);
    const lines = tree.split('\n');
    const hits: string[] = [];
    lines.forEach((line, i) => {
      if (terms.every(t => norm(line).includes(t))) hits.push(lines.slice(Math.max(0, i - context), i + context + 1).join('\n'));
    });
    if (!hits.length) return `Nothing found for "${query}" on ${page.url()}.`;
    return `URL: ${page.url()}\n` + hits.slice(0, 30).join('\n---\n');
  }

  async text(session: string, maxChars = 12_000) {
    const page = await this.page(session);
    const text = await page.evaluate(() => (document.body as any)?.innerText ?? '').catch(() => '');
    const clean = this.redactor.redact(String(text).replace(/\n{3,}/g, '\n\n'));
    return `URL: ${page.url()}\n` + (clean.length > maxChars ? clean.slice(0, maxChars) + '\n… (text cut)' : clean);
  }

  /** Raw page text (all frames) for the purchase gate. Never returned to the model. */
  async rawText(session: string) {
    const page = await this.page(session);
    const texts = await Promise.all(page.frames().map(f => f.evaluate(() => (document.body as any)?.innerText ?? '').catch(() => '')));
    return texts.join('\n');
  }

  async navigate(session: string, url: string) {
    const page = await this.page(session);
    const target = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
    const note = await this.beforeNavigate?.(target).catch(error => `(could not import logins: ${error instanceof Error ? error.message : error})`);
    // A cloud browser's proxy can refuse the first connections right after start; those errors are safe to retry.
    for (let attempt = 0; ; attempt++) {
      try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 }); break; }
      catch (error) {
        if (attempt >= 2 || !/ERR_(TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED)/.test(String(error))) throw error;
        await page.waitForTimeout(1500 * (attempt + 1));
      }
    }
    await this.settle(page);
    return (note ? note + '\n' : '') + (await this.snapshot(session));
  }

  async back(session: string) {
    const page = await this.page(session);
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    await this.settle(page);
    return this.snapshot(session);
  }

  async click(session: string, ref: string) {
    const page = await this.page(session);
    const locator = this.locate(page, ref);
    const name = await this.nameOf(locator);
    if (isPurchaseButton(name)) {
      throw new Error(`"${name}" places an order or pays. Use purchase_propose, wait for the user's approval, then purchase_submit.`);
    }
    await locator.click({ timeout: 12_000 });
    await this.settle(page);
    return this.snapshot(session);
  }

  async type(session: string, ref: string, text: string, submit: boolean) {
    if (containsCardNumber(text)) throw new Error('Card data only goes in through the vault (vault_fill).');
    const page = await this.page(session);
    const locator = this.locate(page, ref);
    try { await locator.fill(text, { timeout: 10_000 }); }
    catch {
      await locator.click({ timeout: 10_000 });
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Delete');
      await locator.pressSequentially(text, { delay: 25 });
    }
    if (submit) return this.pressKey(session, 'Enter');
    await this.settle(page);
    return this.snapshot(session);
  }

  async select(session: string, ref: string, values: string[]) {
    const page = await this.page(session);
    await this.locate(page, ref).selectOption(values, { timeout: 10_000 });
    await this.settle(page);
    return this.snapshot(session);
  }

  async upload(session: string, ref: string, paths: string[]) {
    const page = await this.page(session);
    for (const p of paths) if (!existsSync(p)) throw new Error(`File not found: ${p}`);
    await this.locate(page, ref).setInputFiles(paths, { timeout: 10_000 });
    await this.settle(page);
    return this.snapshot(session);
  }

  async pressKey(session: string, key: string) {
    const page = await this.page(session);
    if (/enter/i.test(key)) {
      const risky = await page.evaluate((pattern: string) => {
        const re = new RegExp(pattern, 'i');
        const form = (document.activeElement as any)?.closest?.('form');
        if (!form) return false;
        return [...form.querySelectorAll('button, input[type=submit]')].some((b: any) => re.test((b.innerText || b.value || '').replace(/\s+/g, ' ').trim()));
      }, PURCHASE_BUTTON.source).catch(() => false);
      if (risky) throw new Error('Enter here would submit the checkout form. Use purchase_submit after approval.');
    }
    await page.keyboard.press(key);
    await this.settle(page);
    return this.snapshot(session);
  }

  async wait(session: string, seconds: number, text?: string) {
    const page = await this.page(session);
    if (text) await page.getByText(text).first().waitFor({ timeout: seconds * 1000 }).catch(() => {});
    else await page.waitForTimeout(seconds * 1000);
    return this.snapshot(session);
  }

  async tabs(session: string, action: 'list' | 'select' | 'close' | 'new', index?: number, url?: string) {
    await this.start();
    const current = await this.page(session);
    const pages = this.context!.pages().filter(p => !p.isClosed());
    if (action === 'new') {
      this.pages.set(session, await this.context!.newPage());
      if (url) return this.navigate(session, url);
    } else if (action === 'select' || action === 'close') {
      const target = pages[index ?? -1];
      if (!target) throw new Error('No such tab');
      if (action === 'close') { await target.close(); if (target === current) this.pages.delete(session); }
      else { this.pages.set(session, target); await target.bringToFront(); }
    }
    const mine = this.pages.get(session);
    return this.context!.pages().filter(p => !p.isClosed()).map((p, i) => `${i}: ${p === mine ? '* ' : ''}${p.url()}`).join('\n');
  }

  async screenshot(session: string) {
    const page = await this.page(session);
    if (this.secretPages.has(page)) throw new Error('This page holds vault data; screenshots are blocked. Use browser_snapshot.');
    return (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64');
  }

  async show(session: string) {
    const page = await this.page(session);
    await page.bringToFront();
    return page.url();
  }

  /** Types a vault secret into a field. The value is registered for redaction before anything is observed. */
  async fillSecret(session: string, ref: string, value: string) {
    const page = await this.page(session);
    await this.typeSecret(page, this.locate(page, ref), value);
    await page.waitForTimeout(300);
  }

  /** Types a secret into a located field; the value is registered for redaction first. */
  private async typeSecret(page: Page, locator: Locator, value: string) {
    this.redactor.add(value);
    this.secretPages.set(page, page.url());
    // A covering banner must not block typing: fill focuses the field by itself.
    await locator.click({ timeout: 2_500 }).catch(async () => { await this.dismissCookies(page); await locator.focus({ timeout: 2_000 }).catch(() => {}); });
    let ok = false;
    try {
      await locator.fill(value, { timeout: 8_000 });
      const typed = await locator.inputValue({ timeout: 3_000 });
      ok = typed === value || (typed.replace(/\D/g, '') === value.replace(/\D/g, '') && /\d/.test(value));
    } catch { ok = false; }
    if (!ok) {
      // Masked inputs often need real key presses.
      await locator.fill('', { timeout: 5_000 }).catch(() => {});
      await locator.pressSequentially(value, { delay: 40 });
    }
  }


  /** Finds login/code fields in any frame and tags them. Returns no field values. */
  private async scanLogin(page: Page): Promise<LoginScan | undefined> {
    const source = scanSource(this.scanOptions.get(page) ?? {});
    const run = async (frame: Frame) => {
      const found = await (frame.evaluate(source) as Promise<Omit<LoginScan, 'frame'>>).catch(() => undefined);
      return found && (found.password || found.username || found.codeFields) ? { frame, ...found } : undefined;
    };
    // Main frame first; embedded login frames (Apple, some banks) in parallel, skipping ads and trackers.
    // Every evaluate is a network round trip on a cloud browser, so this matters there.
    const main = await run(page.mainFrame());
    if (main) return main;
    const others = page.frames().filter(f => f !== page.mainFrame() && /^https:/.test(f.url())
      && !/doubleclick|googlesyndication|googletagmanager|google-analytics|facebook\.com\/tr|adservice|criteo|amazon-adsystem|recaptcha|hcaptcha|challenges\.cloudflare|youtube\.com\/embed|hotjar|clarity\.ms/i.test(f.url()));
    for (const r of await Promise.all(others.map(run))) if (r) return r;
    return undefined;
  }

  private async loginSignature(page: Page) {
    const s = await this.scanLogin(page).catch(() => undefined);
    return JSON.stringify([page.url(), s?.password, s?.username, s?.codeFields, s?.alert, s?.invalid]);
  }

  /** Waits until the URL, the set of login fields or the error text changes. */
  private async waitForLoginChange(page: Page, before: string, timeoutMs = 15_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await page.waitForTimeout(250);
      if (await this.loginSignature(page) !== before) {
        await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(400);
        return true;
      }
    }
    return false;
  }

  private async clickLoginSubmit(page: Page, s: LoginScan) {
    if (!s.submit) return false;
    if (isPurchaseButton(s.submit)) throw new Error('The form button places an order or pays. Use the purchase approval flow.');
    const button = s.frame.locator('[data-inskit=submit]').first();
    for (let i = 0; i < 12 && !(await button.isEnabled().catch(() => false)); i++) await page.waitForTimeout(250);
    try { await button.click({ timeout: 4_000 }); return true; } catch {}
    // Something covers the button: clear a cookie banner, then submit the form with Enter from the focused field.
    if (await this.dismissCookies(page)) { try { await button.click({ timeout: 3_000 }); return true; } catch {} }
    const focused = await s.frame.evaluate(() => (document.activeElement as any)?.tagName === 'INPUT').catch(() => false);
    if (!focused) throw new Error('The sign-in button is covered and no field is focused.');
    await page.keyboard.press('Enter');
    return true;
  }

  /**
   * Fills and submits each login step (username, then password) without a model round trip per action,
   * then classifies where the site landed. A password is submitted at most once.
   */
  async autoLogin(session: string, opts: {
    value: (field: 'username' | 'password', url: string) => string;
    allowed: (url: string) => boolean;
    progress: (stage: 'entering_login' | 'entering_password' | 'waiting_site' | 'checking_result') => void;
    plan: LoginPlan;
    /** Hand forms with extra controls to the model fallback after filling the credentials. */
    handoffExtras?: boolean;
  }): Promise<AutoLoginResult> {
    const page = await this.page(session);
    this.scanOptions.set(page, opts.plan.scan);
    const started = Date.now(), steps: string[] = [];
    let sentUser = false, sentPassword = false, method = '', loginUrl = page.url();
    const done = (outcome: LoginOutcome, alert?: string, reason?: string): AutoLoginResult =>
      ({ outcome, steps, alert: alert ? this.redactor.redact(alert) : undefined, reason, ms: Date.now() - started, passwordSent: sentPassword, method });
    const fill = async (s: LoginScan, field: 'username' | 'password') => {
      opts.progress(field === 'password' ? 'entering_password' : 'entering_login');
      await this.typeSecret(page, s.frame.locator('[data-inskit=' + field + ']').first(), opts.value(field, page.url()));
      steps.push(field);
    };
    try {
      // Single-page apps render the form after load: give it a moment before concluding there is none.
      await this.settleLogin(page, opts.plan);
      await this.dismissCookies(page);
      for (let round = 0; round < 8; round++) {
        if (!opts.allowed(page.url())) return done('left_site');
        if (round) await this.settleLogin(page, opts.plan, 6_000);
        const s = await this.scanLogin(page);
        const c = await this.classifyLogin(page, opts.plan);
        const hasFields = !!(s?.password || s?.username);
        if (sentPassword) {
          // Never a second password submission: whatever is on screen now is the answer.
          if (s?.codeFields && !s.password) return done('code_requested', s.alert);
          if (hasFields || c.rejected || /fail|error|denied|invalid/i.test(new URL(page.url()).pathname)) {
            const rejected = c.rejected || s?.alert || s?.invalid || /fail|error|denied|invalid/i.test(new URL(page.url()).pathname);
            return done(rejected ? 'rejected' : 'no_response', s?.alert || c.rejected);
          }
        }
        if ((c.signup || c.newAccount) && sentUser) return done('rejected', undefined, 'the site offered to create an account');
        if (c.blocked) return done('blocked', undefined, 'the site refused this browser');
        if (c.interstitial) return done('needs_human', undefined, 'bot check did not clear');
        if (s?.codeFields) {
          // Code on the same form as the credentials (TOTP): fill what we have, the code fill submits.
          if (s.username && s.usernameEmpty) await fill(s, 'username');
          if (s.password && s.passwordEmpty) await fill(s, 'password');
          return done('code_requested', s.alert);
        }
        if (c.codeText && !hasFields) return done('code_requested');
        if (c.captcha || (c.passkey && !hasFields)) return done('needs_human', s?.alert, c.captcha ? 'captcha' : 'passkey');
        if (c.chooser && !hasFields) {
          if (!method && opts.plan.preferMethod.length) {
            method = await this.chooseMethod(page, opts.plan.preferMethod);
            if (method) { steps.push('method ' + method); continue; }
          }
          return done('method_choice');
        }
        if (c.app && !hasFields) return done('needs_human', undefined, 'app approval');
        if (!s || !hasFields) return done(this.landed(page, c, opts.plan, sentUser, sentPassword, loginUrl), c.rejected || undefined);
        const fillPassword = s.password && s.passwordEmpty;
        const fillUser = s.username && s.usernameEmpty;
        if (!fillPassword && !fillUser) {
          // The username step came back unchanged after submitting it.
          if (sentUser) return done(c.rejected || s.alert || s.invalid ? 'rejected' : 'no_response', s.alert || c.rejected);
          // A username already filled by the site may not be ours: let the fallback look at it.
          return done('no_login_form', s.alert, 'username already filled');
        }
        if (!s.submit) return done('no_submit_button');
        if (fillUser) await fill(s, 'username');
        if (fillPassword) await fill(s, 'password');
        if (s.extras && opts.handoffExtras) return done('form_extras', undefined, 'the form has other required controls');
        const before = await this.loginSignature(page);
        loginUrl = page.url();
        opts.progress('waiting_site');
        await this.clickLoginSubmit(page, (await this.scanLogin(page)) ?? s);
        steps.push('submit');
        sentUser = true;
        if (s.password) sentPassword = true;
        if (!(await this.waitForLoginChange(page, before))) {
          const c2 = await this.classifyLogin(page, opts.plan);
          const s2 = await this.scanLogin(page);
          return done(c2.rejected || s2?.invalid ? 'rejected' : 'no_response', s2?.alert || c2.rejected);
        }
        opts.progress('checking_result');
      }
    } catch (error) {
      return done('error', undefined, error instanceof Error ? error.message.split('\n')[0].slice(0, 160) : String(error));
    }
    return done('no_login_form');
  }

  /** Accepts a cookie/consent banner when one is in the way. Returns true if it clicked. */
  private async dismissCookies(page: Page) {
    for (const frame of page.frames()) {
      const label = await (frame.evaluate(cookiesSource()) as Promise<string>).catch(() => '');
      if (!label) continue;
      const ok = await frame.locator('[data-inskit-cookie]').first().click({ timeout: 3_000 }).then(() => true, () => false);
      if (ok) { await page.waitForTimeout(400); return true; }
    }
    return false;
  }

  /** Waits until the page shows a form, a recognisable state or real content (SPAs render after load). */
  private async settleLogin(page: Page, plan: LoginPlan, timeoutMs = 8_000) {
    const start = Date.now(), end = start + timeoutMs;
    // Text alone is not enough early on: many sites paint the header before the form.
    const patience = page.url().match(/log-?in|sign-?in|auth|entrar|account|conta|session/i) ? 5_000 : 1_500;
    while (Date.now() < end) {
      const c = await this.classifyLogin(page, plan);
      if (c.busy) { await page.waitForTimeout(300); continue; }
      if (await this.scanLogin(page)) return;
      if (c.captcha || c.chooser || c.codeText || c.logoutLink || c.loggedInSignal || c.rejected || c.blocked) return;
      if (c.textLength > 80 && Date.now() - start > patience) return;
      await page.waitForTimeout(300);
    }
  }

  /** Page-level signals on the main frame: captcha, chooser, code prompt, rejection text, logged-in markers. */
  async classifyLogin(page: Page, plan: LoginPlan): Promise<PageClass> {
    const empty: PageClass = { captcha: false, passkey: false, app: false, chooser: false, codeText: false, rejected: '', logoutLink: false, loggedInSignal: false, loggedOutSignal: false, busy: false, signup: false, newAccount: false, interstitial: false, blocked: false, textLength: 0 };
    const c = await (page.mainFrame().evaluate(classifySource(plan.classify)) as Promise<PageClass>).catch(() => empty);
    return { ...c, rejected: c.rejected ? this.redactor.redact(c.rejected) : '' };
  }

  /** Where did we land once no login field is left? Only clear signals count as logged in. */
  private landed(page: Page, c: PageClass, plan: LoginPlan, sentUser: boolean, sentPassword: boolean, loginUrl: string): LoginOutcome {
    const url = page.url(), path = new URL(url).pathname;
    if ((c.rejected || c.signup || c.newAccount) && (sentUser || sentPassword)) return 'rejected';
    if (c.blocked) return 'blocked';
    if ((sentUser || sentPassword) && /fail|denied|invalid/i.test(path)) return 'rejected';
    if (c.loggedOutSignal) return 'no_login_form';
    if (c.loggedInSignal || c.logoutLink) return 'logged_in';
    // Left the login page after the password, with no error: the site let us in.
    if (sentPassword && url !== loginUrl && !/log-?in|sign-?in|auth|fail|error/i.test(path)) return 'logged_in';
    if (plan.recipe && plan.loginPath && !plan.loginPath.test(url) && (sentPassword || plan.classify.loggedOutText?.length)) return 'logged_in';
    return 'no_login_form';
  }

  private async chooseMethod(page: Page, prefs: string[]) {
    const label = await (page.mainFrame().evaluate(methodSource(prefs)) as Promise<string>).catch(() => '');
    if (!label) return '';
    const before = await this.loginSignature(page);
    await page.locator('[data-inskit-method]').first().click({ timeout: 5_000 });
    await this.waitForLoginChange(page, before, 15_000);
    return label;
  }

  /** Read-only check used by the service and the benchmark. */
  async loginState(session: string, plan: LoginPlan) {
    const page = await this.page(session);
    this.scanOptions.set(page, plan.scan);
    const s = await this.scanLogin(page);
    const c = await this.classifyLogin(page, plan);
    return { fields: !!(s?.password || s?.username), code: !!s?.codeFields, ...c, outcome: (!s || (!s.password && !s.username)) ? this.landed(page, c, plan, false, false, page.url()) : 'no_login_form' as LoginOutcome };
  }

  /** Fills a received one-time code into the visible code field(s) and confirms. takeCode is called only after fields are found. */
  async autoFillCode(session: string, takeCode: (url: string) => string) {
    const page = await this.page(session);
    const started = Date.now();
    const s = await this.scanLogin(page);
    if (!s?.codeFields || !s.codeEnabled) return undefined;
    const boxes = s.frame.locator('[data-inskit-code]');
    const count = await boxes.count();
    const code = takeCode(page.url());
    this.redactor.add(code);
    this.secretPages.set(page, page.url());
    this.codePages.set(page, page.url());
    if (count > 1) {
      if (count !== code.length) throw new Error('The code length does not match the site fields.');
      for (let i = 0; i < count; i++) await s.frame.locator(`[data-inskit-code="${i}"]`).fill(code[i], { timeout: 8_000 });
    } else await this.typeSecret(page, boxes.first(), code);
    const before = await this.loginSignature(page);
    await page.waitForTimeout(500);
    // Many sites submit by themselves after the last digit.
    const after = await this.scanLogin(page);
    if (after?.codeFields && after.codeEnabled && after.submit && after.submitEnabled) await this.clickLoginSubmit(page, after).catch(() => {});
    await this.waitForLoginChange(page, before, 20_000);
    return { ms: Date.now() - started };
  }

  async validateSecretParts(session: string, refs: string[]) {
    if (!Array.isArray(refs) || refs.length < 3 || refs.length > 32 || new Set(refs).size !== refs.length) throw new Error('Supply distinct verification field refs.');
    const page = await this.page(session);
    for (const ref of refs) {
      const locator = this.locate(page, ref);
      const valid = await locator.evaluate((el: any) => el.tagName === 'INPUT' && ['text','tel','number','password'].includes(el.type));
      if (!valid || !await locator.isEditable() || !await locator.isVisible()) throw new Error('Verification targets must be visible editable input fields.');
    }
  }

  /** Fill split OTP fields without exposing individual digits in snapshots. */
  async fillSecretParts(session: string, refs: string[], value: string) {
    if (!Array.isArray(refs) || refs.length !== value.length || new Set(refs).size !== refs.length || refs.length < 3 || refs.length > 32) throw new Error('Supply one distinct field per code character.');
    const page = await this.page(session);
    const locators = refs.map(ref => this.locate(page, ref));
    await this.validateSecretParts(session, refs);
    this.redactor.add(value);
    this.secretPages.set(page, page.url());
    const masked = this.secretFieldRefs.get(page) ?? new Set<string>();
    refs.forEach(ref => masked.add(ref)); this.secretFieldRefs.set(page, masked);
    for (let i = 0; i < refs.length; i++) await locators[i].fill(value[i], { timeout: 8000 });
    await page.waitForTimeout(300);
  }

  async clickPurchase(session: string, ref: string) {
    const page = await this.page(session);
    await this.locate(page, ref).click({ timeout: 15_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
    return this.snapshot(session);
  }

  async currentUrl(session: string) {
    return (await this.page(session)).url();
  }
}
