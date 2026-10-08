import { execFile } from 'node:child_process';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { AgentBrowser } from './browser.ts';
import { detectBrowsers, listProfiles, readCookies } from './browser-cookies.ts';
import { containsCardNumber } from './redact.ts';
import { hostOf, siteOf, sameLoginSite, type RequestKind, type Vault } from './vault.ts';
import { money, type Order, type Purchases } from './purchases.ts';
import { TOOL_NAMES, type ToolResult } from './tools.ts';
import { learnSubmitName, planFor } from './login/recipes.ts';
import { configuredModel, runModelDriver, type ModelName, type Usage } from './login/model.ts';
import { runDelegate } from './delegate.ts';
import { AgentInbox, loadInboxConfig } from './inbox.ts';

export type Profile = {
  name?: string;
  email?: string;
  phone?: string;
  addresses?: { label: string; address: string; postal_code?: string }[];
  notes?: string[];
};

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function openInBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise<boolean>(resolve => execFile(cmd, args, error => resolve(!error)));
}

export class Service {
  private locks = new Map<string, Promise<unknown>>();
  private cookieError?: string;
  private loginSessions = new Map<string, string>();
  /** Code fills started by the vault page itself, so they finish even when no agent is waiting. */
  private autoFills = new Map<string, Promise<string | undefined>>();
  /** The agent's own mailbox, for accounts it creates. Replaceable in tests. */
  inbox: AgentInbox;

  constructor(
    private cfg: Config,
    private db: Db,
    private browser: AgentBrowser,
    readonly vault: Vault,
    readonly purchases: Purchases,
  ) {
    browser.beforeNavigate = url => this.syncSite(url);
    this.inbox = new AgentInbox(loadInboxConfig(cfg.home));
  }

  /** Import a site's cookies from the everyday browser the first time the agent visits it. */
  private async syncSite(url: string) {
    if (!this.cfg.cookieSync || this.cookieError) return undefined;
    const host = hostOf(url);
    if (!host || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return undefined;
    const site = siteOf(host);
    const done = this.db.sql.prepare('select 1 from cookie_sync where site = ?').get(site);
    if (done) return undefined;
    try {
      const n = await this.importCookies({ sites: [site] });
      return n.added ? `(Imported ${n.added} cookies for ${site} from the user's ${n.browser}.)` : undefined;
    } catch (error) {
      this.cookieError = error instanceof Error ? error.message : String(error);
      return `(Login import is off for now: ${this.cookieError})`;
    }
  }

  async importCookies(opts: { sites?: string[]; all?: boolean; browser?: string; profile?: string }) {
    const settings = this.db.get<{ browser?: string; profile?: string }>('cookie_source') ?? {};
    const browser = opts.browser ?? settings.browser;
    const profile = opts.profile ?? settings.profile ?? this.cfg.chromeProfile;
    const sites = (opts.sites ?? []).map(s => siteOf(hostOf(s) || s));
    if (!opts.all && !sites.length) throw new Error('Pass sites or all=true.');
    const filter = opts.all ? undefined : (h: string) => sites.includes(siteOf(h));
    const read = await readCookies({ browser, profile, hostFilter: filter });
    const added = await this.browser.addCookies(read.cookies);
    if (opts.browser || opts.profile) this.db.set('cookie_source', { browser: opts.browser ?? browser, profile: opts.profile ?? profile });
    const now = Date.now();
    const bySite = new Map<string, number>();
    for (const c of read.cookies) bySite.set(siteOf(c.domain), (bySite.get(siteOf(c.domain)) ?? 0) + 1);
    for (const site of opts.all ? bySite.keys() : sites) {
      this.db.sql.prepare('insert into cookie_sync (site, count, imported_at) values (?, ?, ?) on conflict(site) do update set count = excluded.count, imported_at = excluded.imported_at')
        .run(site, bySite.get(site) ?? 0, now);
    }
    this.cookieError = undefined;
    this.db.audit('cookies.import', { sites: opts.all ? 'all' : sites, added, browser: read.browser, profile: read.profile });
    return { added, failed: read.failed, browser: `${read.browser} (${read.profile})` };
  }

  private async exclusive<T>(session: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(session) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(session, next);
    try { return await next; }
    finally { if (this.locks.get(session) === next) this.locks.delete(session); }
  }

  async call(session: string, name: string, args: any, opts: { nativeApproval?: boolean } = {}): Promise<ToolResult> {
    if (!TOOL_NAMES.has(name) && !name.startsWith('__')) return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
    const logged = name === 'browser_type' ? { ...args, text: '[typed text]' } : name === 'vault_challenge_code' ? { ...args, code: '[code]' } : args;
    this.db.audit('tool', { session: session.slice(0, 8), name, args: logged });
    const run = () => this.withLoginProgress(session, name, args ?? {}, () => this.dispatch(session, name, args ?? {}, opts));
    try {
      const out = name.endsWith('_wait') ? await run() : await this.exclusive(session, run);
      return typeof out === 'string' ? ok(out) : out;
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      this.db.audit('tool.error', { name, message });
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  /** Report actual work on a bound login, never synthetic milestones from a timer. */
  private async withLoginProgress<T>(session: string, name: string, args: any, run: () => Promise<T>): Promise<T> {
    const watched = ['browser_navigate','browser_click','browser_press_key','browser_snapshot','browser_find','browser_read_text','browser_wait'];
    const itemId = this.loginSessions.get(session);
    if (!itemId || !watched.includes(name)) return run();
    const item = this.vault.item(itemId), login = this.vault.loginStatus(itemId);
    if (!item?.origin || !login || ['verified','failed','action_required'].includes(login.state)) return run();
    const url = name === 'browser_navigate' ? args.url : await this.browser.currentUrl(session);
    if (!sameLoginSite(item.origin, url)) return run();
    const waiting = ['browser_click','browser_press_key','browser_wait'].includes(name);
    this.vault.loginProgress(itemId, name === 'browser_navigate' ? 'opening_site' : waiting ? 'waiting_site' : login.stage ?? 'checking_result');
    try {
      const result = await run();
      if (sameLoginSite(item.origin, await this.browser.currentUrl(session))) this.vault.loginProgress(itemId, 'checking_result');
      return result;
    } catch (error) {
      this.vault.loginProgress(itemId, 'interrupted');
      throw error;
    }
  }

  /**
   * Login chain: site recipe (or generic heuristics) first, then a fast inner model only when the
   * deterministic pass could not tell what the page is. Every run is recorded for tuning.
   */
  private async attemptLogin(session: string, itemId: string, fallbackArg?: string): Promise<ToolResult> {
    const item = this.vault.item(itemId);
    if (item?.kind !== 'login' || !item.origin) throw new Error('A saved login is required.');
    const origin = item.origin;
    const startUrl = await this.browser.currentUrl(session);
    const plan = planFor(this.cfg.home, this.db, startUrl);
    const wanted = fallbackArg || process.env.INSKIT_LOGIN_FALLBACK;
    const fallback: 'off' | ModelName = wanted === 'off' ? 'off' : configuredModel(wanted) ?? 'off';
    this.loginSessions.set(session, item.id);
    this.vault.loginFeedback(item.id, { state: 'testing' });
    const started = Date.now();
    const first = plan.recipe ? 'recipe' : 'heuristic';
    const tried: string[] = [first];
    const r = await this.browser.autoLogin(session, {
      value: (field, url) => this.vault.valueForFill(item.id, field, url),
      allowed: url => sameLoginSite(origin, url),
      progress: stage => this.vault.loginProgress(item.id, stage),
      plan,
      handoffExtras: fallback !== 'off',
    });
    let outcome: string = r.outcome, driver = first, steps = [...r.steps], reason = r.reason, model: (Usage & { name: string }) | undefined;
    const unclear = ['no_login_form', 'no_submit_button', 'no_response', 'form_extras', 'error'].includes(r.outcome);
    if (unclear && fallback !== 'off') {
      tried.push('model');
      const m = await this.modelLogin(session, item.id, origin, fallback, r.passwordSent).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
      if ('error' in m) reason = m.error;
      else {
        driver = 'model'; outcome = m.outcome; steps.push(...m.steps.map(s => 'model:' + s)); reason = m.reason;
        model = { name: fallback, ...m.usage };
        if (!['no_login_form', 'needs_human'].includes(m.outcome)) for (const t of m.trace) if (t.action === 'click' && t.name) learnSubmitName(this.db, startUrl, t.name);
      }
    }
    const ms = Date.now() - started;
    if (outcome === 'left_site' || outcome === 'error') this.vault.loginProgress(item.id, 'interrupted');
    this.db.sql.prepare('insert into login_runs (site, driver, drivers_tried, outcome, ms, steps, model, input_tokens, output_tokens, cost_usd, recipe, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(siteOf(hostOf(startUrl)), driver, tried.join(','), outcome, ms, steps.join(' → '), model?.name ?? null, model?.input_tokens ?? 0, model?.output_tokens ?? 0, model?.cost_usd ?? 0, plan.recipe ? plan.recipe.id + '@' + plan.recipe.version : null, Date.now());
    const next: Record<string, string> = {
      logged_in: 'The page shows an authenticated-only signal. Confirm it on the snapshot, then vault_login_feedback verified.',
      code_requested: 'The site asks for a one-time code. If it goes somewhere you can read (e.g. the user’s email via an email tool), fetch it and call vault_challenge_code. Otherwise call vault_login_challenge now with the visible instruction; the code field appears on the vault page and is filled automatically.',
      method_choice: 'The site asks how to verify. Click the method the user prefers (SMS if unknown), then vault_login_challenge.',
      needs_human: 'Only the user can do this step (CAPTCHA, passkey or approval on the phone). Use browser_hand_over or vault_login_challenge method=app.',
      rejected: 'The site did not accept the credentials. If it clearly says the email or password is wrong, report vault_login_feedback failed with that reason. Do not retry.',
      no_login_form: 'No login form was recognised. Read the snapshot; it may need a click on a Sign in link first.',
      no_response: 'The site did not react after submit. Read the snapshot before doing anything else; never resubmit the password.',
      left_site: 'The tab left the login site. Inspect it before continuing.',
      no_submit_button: 'Fields were found but no continue/sign-in button. Use vault_fill and browser_click with refs from the snapshot.',
      form_extras: 'The form needs other controls besides the credentials (filled already). Complete them from the snapshot and submit once.',
      blocked: 'The site refused this browser (block page). Try again later or in the cloud browser; do not retry in a loop.',
      error: 'The automatic login hit an error. Read the snapshot and continue manually with vault_fill and browser_click.',
    };
    const snap = await this.browser.snapshot(session, 6_000).catch(() => '');
    const how = driver + (tried.length > 1 && driver !== 'model' ? ' (model fallback failed)' : '');
    const textOut = 'Outcome: ' + outcome + ' after ' + (ms / 1000).toFixed(1) + 's (' + (steps.join(' → ') || 'nothing filled') + ') via ' + how + '.'
      + (r.alert ? ' Site message: "' + r.alert + '".' : '') + (reason ? ' Note: ' + reason + '.' : '') + ' ' + (next[outcome] ?? '') + '\n' + snap;
    return { content: [{ type: 'text', text: textOut }], structuredContent: { outcome, driver, drivers_tried: tried, ms, steps, recipe: plan.recipe?.id, model } };
  }

  /** Hands the current page to the inner model. Secrets still go through the vault; the model only names refs. */
  private async modelLogin(session: string, itemId: string, origin: string, model: ModelName, passwordSent: boolean) {
    const b = this.browser;
    const onSite = async () => { if (!sameLoginSite(origin, await b.currentUrl(session))) throw new Error('The page left the login site.'); };
    return runModelDriver(model, {
      snapshot: () => b.snapshot(session, 8_000),
      fill: async (ref, field) => {
        await onSite();
        this.vault.loginProgress(itemId, field === 'password' ? 'entering_password' : 'entering_login');
        await b.fillSecret(session, ref, this.vault.valueForFill(itemId, field, await b.currentUrl(session)));
      },
      click: async ref => { await onSite(); this.vault.loginProgress(itemId, 'waiting_site'); await b.click(session, ref); this.vault.loginProgress(itemId, 'checking_result'); },
      select: async (ref, value) => { await onSite(); await b.select(session, ref, [value]); },
      wait: async seconds => { await b.wait(session, seconds); },
    }, { passwordSent, context: 'Site: ' + hostOf(origin) + '. Goal: sign in with the saved login. Textboxes showing [hidden by vault] are already filled; complete any other required controls, then submit once.' });
  }

  /** Called by the vault page when the user submits a code: fill and confirm it on the site right away. */
  startAutoFill(challengeId: string) {
    const c = this.vault.challenge(challengeId);
    if (!c || c.method !== 'code' || c.status !== 'ready' || this.autoFills.has(c.id)) return;
    const run = this.exclusive(c.session, () => this.autoFillCode(c.session, c.id))
      .catch(error => 'Automatic code fill failed: ' + (error instanceof Error ? error.message.split('\n')[0] : String(error)) + '. Inspect the page.');
    this.autoFills.set(c.id, run);
    setTimeout(() => this.autoFills.delete(c.id), 15 * 60_000).unref();
  }

  /** Fills a ready code on the challenge page automatically. Returns undefined when the fields are not recognisable. */
  private async autoFillCode(session: string, challengeId: string) {
    const c = this.vault.challengeForSession(challengeId, session);
    const url = await this.browser.currentUrl(session).catch(() => '');
    try { if (!url || new URL(url).origin !== c.origin) return undefined; } catch { return undefined; }
    this.vault.loginProgress(c.itemId, 'checking_code');
    const r = await this.browser.autoFillCode(session, pageUrl => this.vault.takeChallengeCode(challengeId, session, pageUrl));
    if (!r) return undefined;
    this.vault.loginProgress(c.itemId, 'checking_result');
    return `Code filled and confirmed automatically in ${(r.ms / 1000).toFixed(1)}s. Check the page: authenticated-only signal → vault_login_feedback verified; "invalid code" → vault_login_challenge with error=invalid_code.\n${await this.browser.snapshot(session, 6_000)}`;
  }

  private link(path: string) {
    return `${this.cfg.publicUrl}${path}`;
  }

  /** Opens a private page for the human. Returns text for the agent (without the URL when opened locally). */
  private async present(path: string, what: string) {
    const url = this.link(path);
    if (this.cfg.openLinks && (await openInBrowser(url))) return `A secure page for ${what} just opened in the user's browser.`;
    return `Give the user this link for ${what} (it works once): ${url}`;
  }

  /** Next step after a proposal when no native prompt answered: ask in chat, or open the approval page. */
  private async askApproval(order: Order) {
    const token = this.purchases.issueToken(order.id);
    if (this.cfg.approval === 'page') {
      return `${await this.present(`/a/${token}`, 'approving this purchase')} Tell the user in one line, then call purchase_wait with order_id="${order.id}".`;
    }
    return `Approval in chat: show the user this order (items, total, delivery date, address, card brand and last 4) and ask whether to buy it. End your turn and wait for their reply; do not call purchase_wait. When their next message answers it, call purchase_approve with order_id="${order.id}", approve, and their exact words. If they prefer to approve on a page, give them this one-time link: ${this.link(`/a/${token}`)}`;
  }

  private async dispatch(session: string, name: string, a: any, opts: { nativeApproval?: boolean }): Promise<ToolResult | string> {
    const b = this.browser;
    switch (name) {
      case 'browser_navigate': return b.navigate(session, a.url);
      case 'browser_snapshot': return b.snapshot(session, a.max_chars);
      case 'browser_find': return b.find(session, a.query);
      case 'browser_read_text': return b.text(session, a.max_chars);
      case 'browser_click': return b.click(session, a.ref);
      case 'browser_type':
        if (containsCardNumber(a.text)) throw new Error('Card data only goes in through the vault (vault_fill).');
        return b.type(session, a.ref, a.text, !!a.submit);
      case 'browser_select': return b.select(session, a.ref, a.values);
      case 'browser_press_key': return b.pressKey(session, a.key);
      case 'browser_back': return b.back(session);
      case 'browser_wait': return b.wait(session, a.seconds, a.text);
      case 'browser_tabs': return b.tabs(session, a.action, a.index, a.url);
      case 'browser_screenshot': return { content: [{ type: 'image', data: await b.screenshot(session), mimeType: 'image/jpeg' }] };
      case 'browser_upload': return b.upload(session, a.ref, a.paths);
      case 'browser_downloads':
        return b.downloads.length ? b.downloads.map(d => `${new Date(d.at).toISOString()} ${d.file} (from ${hostOf(d.url)})`).join('\n') : `No downloads yet. Files are saved to ${this.cfg.downloadsDir}.`;
      case 'browser_delegate': {
        const model = configuredModel(a.model || process.env.INSKIT_DELEGATE_MODEL);
        if (!model) return 'browser_delegate needs an inner model on this machine (INSKIT_LUNA_BASE_URL or ANTHROPIC_API_KEY in ~/.instinct/config.json). Do the steps yourself with the browser_* tools.';
        const started = Date.now();
        const r = await runDelegate(model, {
          snapshot: () => b.snapshot(session, 9_000),
          navigate: async url => { await b.navigate(session, url); },
          click: async ref => { await b.click(session, ref); },
          type: async (ref, text, submit) => {
            if (containsCardNumber(text)) throw new Error('Card data only goes in through the vault.');
            await b.type(session, ref, text, submit);
          },
          select: async (ref, value) => { await b.select(session, ref, [value]); },
          press: async key => { await b.pressKey(session, key); },
          fillLogin: async (ref, field) => {
            const url = await b.currentUrl(session);
            const login = this.vault.list().find(i => i.kind === 'login' && i.origin && sameLoginSite(i.origin, url));
            if (!login) throw new Error('No saved login for this site.');
            await b.fillSecret(session, ref, this.vault.valueForFill(login.id, field, url));
          },
          wait: async seconds => { await b.wait(session, seconds); },
        }, String(a.task), { maxActions: a.max_actions, budgetMs: (a.budget_seconds ?? 120) * 1000 });
        const ms = Date.now() - started;
        const text = (r.success ? 'Done' : 'Not finished') + ' by ' + model + ' in ' + (ms / 1000).toFixed(1) + 's, ' + r.steps.length + ' actions, ' + r.usage.calls + ' model calls.\nResult: ' + r.result + '\nSteps: ' + r.steps.join(' → ');
        return { content: [{ type: 'text', text }], structuredContent: { success: r.success, result: r.result, ms, steps: r.steps, model: { name: model, ...r.usage } } };
      }
      case 'browser_hand_over': {
        const url = await b.show(session);
        this.db.audit('handover', { reason: a.reason, url });
        if (this.cfg.browserUse) return b.liveUrl
          ? `Ask the user to open the cloud browser at ${b.liveUrl} and complete this step: ${a.reason}. Wait for their reply, then take a fresh snapshot.`
          : 'The cloud browser did not return a live preview link. Ask the user to open its session in Browser Use Cloud.';
        return this.cfg.cdpUrl || this.cfg.headless
          ? `The browser is not visible on the user's screen (${b.mode}). Ask them to do it on their own device if possible: ${a.reason}`
          : `The agent browser window is in front on ${hostOf(url)}. Tell the user exactly what to do, wait for their reply, then take a fresh snapshot.`;
      }

      case 'logins_import': {
        if (a.list) {
          const browsers = detectBrowsers();
          if (!browsers.length) return 'No Chromium-based browser found on this computer.';
          const current = this.db.get<{ browser?: string; profile?: string }>('cookie_source');
          return browsers.map(br => `${br.name} (${br.id}): ${listProfiles(br).map(p => `${p.name} [${p.dir}]${p.lastUsed ? ' (last used)' : ''}`).join(', ')}`).join('\n')
            + `\nCurrent source: ${current?.browser ?? 'first found'} / ${current?.profile ?? 'last used profile'}`;
        }
        const r = await this.importCookies({ sites: a.sites, all: a.all, browser: a.browser, profile: a.profile });
        return `Imported ${r.added} cookies from ${r.browser}${r.failed ? ` (${r.failed} could not be decrypted)` : ''}. Reload the page to use them.`;
      }

      case 'profile_get': return JSON.stringify(this.db.get<Profile>('profile') ?? {});
      case 'profile_update': {
        const current = this.db.get<Profile>('profile') ?? {};
        const next: Profile = { ...current };
        if (a.name) next.name = a.name;
        if (a.email) next.email = a.email;
        if (a.phone) next.phone = a.phone;
        if (a.addresses) next.addresses = a.addresses;
        if (a.note) next.notes = [...(current.notes ?? []), a.note].slice(-50);
        this.db.set('profile', next);
        return `Profile saved: ${JSON.stringify(next)}`;
      }

      case 'vault_list': {
        const items = this.vault.list();
        return items.length ? JSON.stringify(items) : 'The vault is empty. Use vault_request to ask the user for a card, login or ID.';
      }
      case 'vault_request': {
        const request = this.vault.createRequest({ kind: a.kind as RequestKind, purpose: a.purpose, origin: a.origin, itemId: a.item_id });
        const shown = await this.present(`/v/${request.token}`, a.kind === 'cvv' ? 'the CVV' : a.kind);
        return `${shown} Request ${request.id}. Tell the user in one line, then call vault_wait with request_id="${request.id}".`;
      }
      case 'vault_wait': {
        const deadline = Date.now() + (a.timeout_seconds ?? 180) * 1000;
        for (;;) {
          const r = this.vault.latestRequest(a.request_id);
          if (!r) throw new Error('Unknown request (the daemon may have restarted). Create a new one.');
          if (r.status === 'done' && r.login?.state !== 'failed') {
            if (r.kind === 'login') this.loginSessions.set(session, r.resultItemId!);
            if (r.kind === 'login' && r.login?.state === 'saved') this.vault.loginFeedback(r.resultItemId!, { state: 'testing' });
            const item = r.resultItemId ? this.vault.item(r.resultItemId) : undefined;
            const saved = `Done. ${r.kind === 'cvv' ? 'CVV ready for one use with' : 'Saved as'} item_id="${r.resultItemId}"${item ? ` (${item.label})` : ''}.`;
            if (r.kind !== 'login' || !item?.origin) return saved;
            const here = await b.currentUrl(session).catch(() => '');
            if (here && sameLoginSite(item.origin, here)) { const res = await this.attemptLogin(session, item.id); return { ...res, content: [{ type: 'text', text: saved + ' Credentials saved. Automatic login attempt:\n' + (res.content[0] as any).text }] }; }
            return `${saved} Credentials are saved, NOT yet verified. Open the site's login page and call vault_login_attempt immediately, without asking the user in chat. If 2FA is needed call vault_login_challenge so they can finish on the same vault page. Then report the observed result via vault_login_feedback.`;
          }
          if (r.status === 'expired') return 'The link expired. Ask again only if the user still wants to continue.';
          if (Date.now() > deadline) return 'Still waiting for the user. Call vault_wait again, or ask them in chat if they need help.';
          await sleep(800);
        }
      }
      case 'vault_generate_login': {
        const id = this.vault.generateLogin(a.origin, a.username, a.length, a.symbols);
        return `Created login item_id="${id}" for ${hostOf(a.origin)} (username ${a.username}). Fill it with vault_fill.`;
      }
      case 'vault_login_attempt': {
        const item = this.vault.item(a.item_id);
        if (item?.kind !== 'login' || !item.origin) throw new Error('vault_login_attempt needs a saved login item_id.');
        if (a.url) {
          if (!sameLoginSite(item.origin, a.url)) throw new Error('The login page must be on the saved login site.');
          await b.navigate(session, a.url);
        }
        if (!sameLoginSite(item.origin, await b.currentUrl(session))) throw new Error(`Open the ${hostOf(item.origin)} login page first, or pass url.`);
        return this.attemptLogin(session, item.id, a.model_fallback);
      }
      case 'vault_login_feedback': {
        const item = this.vault.item(a.item_id);
        const url = await b.currentUrl(session);
        if (item?.kind !== 'login' || !item.origin || !sameLoginSite(item.origin, url)) throw new Error('Login feedback must come from the login’s site.');
        if (!['testing','action_required','verified','failed'].includes(a.state)) throw new Error('Invalid login state.');
        const visible = await b.text(session, 1_000_000);
        if (typeof a.evidence !== 'string' || a.evidence.length < 4 || a.evidence.length > 200 || !visible.includes(a.evidence) || a.evidence.includes('[hidden by vault]')) throw new Error('Evidence is not visible on the current page. Take a fresh snapshot.');
        const r = this.vault.loginFeedback(item.id, { state: a.state, reason: a.reason });
        this.loginSessions.set(session, item.id);
        return `Login status: ${r.login!.state}. Request ${r.id}. ${a.show_page ? await this.present(`/v/${r.token}`, 'login status') : 'The vault page updates automatically.'}`;
      }
      case 'vault_login_challenge': {
        const url = await b.currentUrl(session);
        const visible = await b.text(session, 1_000_000);
        if (typeof a.evidence !== 'string' || a.evidence.length < 4 || a.evidence.length > 200 || !visible.includes(a.evidence) || a.evidence.includes('[hidden by vault]')) throw new Error('Challenge evidence is not visible on the current page.');
        const { request, challenge } = this.vault.createChallenge(a.item_id, session, url, a);
        this.loginSessions.set(session, a.item_id);
        // A login saved earlier has no vault page open (or its page expired): open one so the code field is visible.
        const where = this.vault.loginPageOpen(a.item_id)
          ? 'The verification field appeared on the vault page the user already has open.'
          : await this.present(`/v/${request.token}`, a.method === 'app' ? 'confirming the app approval' : 'typing the verification code');
        return `${where} challenge_id="${challenge.id}". Call vault_challenge_wait now; do not ask for a code in chat.`;
      }
      case 'vault_challenge_code': {
        let id: string = a.challenge_id;
        if (!id) {
          // No vault page needed: the agent already has the code, so create the challenge silently.
          if (!a.item_id) throw new Error('Pass challenge_id, or item_id with evidence of the code prompt.');
          const url = await b.currentUrl(session);
          const visible = await b.text(session, 1_000_000);
          if (typeof a.evidence !== 'string' || a.evidence.length < 4 || a.evidence.length > 200 || !visible.includes(a.evidence) || a.evidence.includes('[hidden by vault]')) throw new Error('Challenge evidence is not visible on the current page.');
          const channel = ['sms', 'email', 'whatsapp', 'authenticator'].includes(a.source) ? a.source : 'sms';
          id = this.vault.createChallenge(a.item_id, session, url, { method: 'code', channel, instruction: 'Código obtido pelo agente.' }).challenge.id;
          this.loginSessions.set(session, a.item_id);
        }
        this.vault.provideChallengeCode(id, session, String(a.code ?? ''), a.source);
        return (await this.autoFillCode(session, id))
          ?? `Code ready (challenge_id="${id}") but the code field was not recognised. Use vault_challenge_fill with the field ref(s), then submit and inspect the page.`;
      }
      case 'vault_challenge_wait': {
        const deadline = Date.now() + Math.min(60, Math.max(1, a.timeout_seconds ?? 50)) * 1000;
        for (;;) {
          const c = this.vault.challengeForSession(a.challenge_id, session);
          if (c.status === 'ready') {
            if (c.method !== 'code') return 'The user reports approving in the app. Check the site; this is not proof of successful login.';
            const pending = this.autoFills.get(c.id);
            return (await (pending ?? this.autoFillCode(session, c.id))) ?? 'Code received privately. Use vault_challenge_fill, then submit the site verification form and inspect the result.';
          }
          if (c.status === 'consumed' && this.autoFills.has(c.id)) return (await this.autoFills.get(c.id)) ?? 'The code was used. Inspect the page.';
          if (c.status !== 'pending') return `Challenge ${c.status}. Inspect the site before requesting another verification.`;
          if (Date.now() >= deadline) return 'Still waiting on the vault page. Continue vault_challenge_wait; no chat response is needed.';
          await sleep(300);
        }
      }
      case 'vault_challenge_fill': {
        if (!!a.ref === !!a.refs) throw new Error('Pass either ref or refs.');
        if (a.refs) await b.validateSecretParts(session, a.refs);
        const value = this.vault.takeChallengeCode(a.challenge_id, session, await b.currentUrl(session));
        if (a.refs) await b.fillSecretParts(session, a.refs, value);
        else await b.fillSecret(session, a.ref, value);
        return 'Filled the verification code privately and discarded it. Submit the site verification form and report the actual result.';
      }
      case 'vault_fill': {
        const item = this.vault.item(a.item_id);
        if (!item) throw new Error('Vault item not found.');
        const url = await b.currentUrl(session);
        if (item.kind === 'card' && !this.purchases.active(url)) {
          throw new Error('Card data is only filled on the store of an active proposal. Call purchase_propose first.');
        }
        const value = this.vault.valueForFill(a.item_id, a.field, url);
        await b.fillSecret(session, a.ref, value);
        if (item.kind === 'login') {
          this.loginSessions.set(session, item.id);
          this.vault.loginFeedback(item.id, { state: 'testing' });
          this.vault.loginProgress(item.id, a.field === 'password' ? 'entering_password' : 'entering_login');
        }
        return `Filled ${a.field} from "${item.label}" (value hidden).`;
      }

      case 'purchase_propose': {
        const { order } = this.purchases.propose(a.store_name, a.store_url, a.currency, {
          items: a.items.map((i: any) => ({ name: i.name, quantity: i.quantity, unitPriceCents: i.unit_price_cents })),
          subtotalCents: a.subtotal_cents, shippingCents: a.shipping_cents, taxCents: a.tax_cents ?? 0, discountCents: a.discount_cents ?? 0,
          totalCents: a.total_cents, shippingMethod: a.shipping_method, deliveryEstimate: a.delivery_estimate,
          address: a.address, paymentMethod: a.payment_method, notes: a.notes,
        });
        const summary = `${order.storeName}: ${order.quote.items.map(i => `${i.quantity}× ${i.name}`).join(', ')} — total ${money(order.totalCents, order.currency)}, ${order.quote.paymentMethod}, delivery ${order.quote.deliveryEstimate} to ${order.quote.address}`;
        const structured = { orderId: order.id, summary };
        if (opts.nativeApproval) return { content: [{ type: 'text', text: `Proposal ${order.id}: ${summary}` }], structuredContent: structured };
        return { content: [{ type: 'text', text: `Proposal ${order.id}: ${summary}. ${await this.askApproval(order)}` }], structuredContent: structured };
      }
      case '__open_approval': {
        const order = this.purchases.get(a.order_id);
        if (!order || order.status !== 'awaiting_approval') throw new Error('No proposal awaiting approval.');
        return this.askApproval(order);
      }
      case '__decide': {
        const order = this.purchases.decide(a.order_id, !!a.approve, a.via ?? 'native prompt');
        return `${order.id} ${order.status}`;
      }
      case 'purchase_approve': {
        const reply = String(a.user_reply ?? '').replace(/\s+/g, ' ').trim();
        if (!reply) throw new Error("Pass the user's reply verbatim in user_reply.");
        const order = this.purchases.decide(a.order_id, a.approve === true, `chat: "${reply}"`);
        return order.status === 'approved'
          ? `Approved in chat. Fill payment if needed, check the total is still ${money(order.totalCents, order.currency)}, then purchase_submit.`
          : 'Recorded: the user declined. Do not buy. Ask what they want instead.';
      }
      case 'purchase_wait': {
        const deadline = Date.now() + (a.timeout_seconds ?? 180) * 1000;
        for (;;) {
          const order = this.purchases.get(a.order_id);
          if (!order) throw new Error('Order not found');
          if (order.status === 'approved') return `Approved by the user. Fill payment if needed, check the total is still ${money(order.totalCents, order.currency)}, then purchase_submit.`;
          if (order.status === 'rejected') return 'The user declined. Do not buy. Ask what they want instead.';
          if (order.status !== 'awaiting_approval') return `Order is ${order.status}${order.failure ? `: ${order.failure}` : ''}.`;
          if (Date.now() > deadline) return `No decision yet. Call purchase_wait again, or ask the user in chat and record their answer with purchase_approve (order_id="${order.id}").`;
          await sleep(800);
        }
      }
      case 'purchase_submit': {
        const order = this.purchases.checkSubmit(a.order_id, await b.currentUrl(session), await b.rawText(session));
        this.purchases.markSubmitted(order.id);
        const snap = await b.clickPurchase(session, a.ref);
        return `Clicked the final button for ${order.id}. Read the page: if it shows an order number, call purchase_confirm; if it is unclear, do NOT click again — check the store's order history and tell the user.\n${snap}`;
      }
      case 'purchase_confirm': {
        const order = this.purchases.confirm(a.order_id, a.store_order_number, a.paid_total_cents, await b.rawText(session));
        return `Confirmed: ${order.storeName} order ${order.storeOrderNumber}, paid ${money(order.paidTotalCents ?? order.totalCents, order.currency)}.`;
      }
      case 'purchase_cancel': {
        const order = this.purchases.fail(a.order_id, a.reason);
        return `${order.id} is now ${order.status}.`;
      }
      case 'purchase_list': {
        const list = this.purchases.list(10);
        return list.length ? JSON.stringify(list.map(o => ({ id: o.id, status: o.status, store: o.storeName, total: money(o.totalCents, o.currency), storeOrder: o.storeOrderNumber, created: new Date(o.createdAt).toISOString() }))) : 'No purchases yet.';
      }

      case 'agent_status': {
        const synced = (this.db.sql.prepare('select count(*) n from cookie_sync').get() as any).n;
        const source = this.db.get<{ browser?: string; profile?: string }>('cookie_source');
        const browsers = detectBrowsers();
        return [
          `Agent browser: ${b.running ? 'open' : 'starts on first use'} (${b.mode})`,
          `Login import: ${!this.cfg.cookieSync ? 'manual (logins_import)' : this.cookieError ? 'paused: ' + this.cookieError : 'automatic per site'}; source ${source?.browser ?? browsers[0]?.name ?? 'none found'}${source?.profile ? ' / ' + source.profile : ''}; ${synced} sites imported`,
          `Vault: ${this.vault.list().length} items · Profile: ${this.db.get('profile') ? 'set' : 'empty'}`,
          `Agent mailbox: ${this.inbox.config ? this.inbox.config.address + ' (use it to create accounts; read with inbox_read)' : 'not configured'}`,
          `Home page for the user (cards, ID, purchases): ${this.link('/')}`,
        ].join('\n');
      }

      case 'inbox_address': return `${this.inbox.address} — the agent's own mailbox. Use it as the email when creating accounts for the user (vault_generate_login username), so codes and confirmation links arrive where you can read them with inbox_read. The user's own accounts keep the user's email.`;
      case 'inbox_read': return this.inbox.read(a);
    }
    throw new Error(`Unknown tool ${name}`);
  }
}
