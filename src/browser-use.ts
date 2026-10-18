import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { BRAND } from './brand.ts';

type CloudSession = { id: string; cdpUrl: string; liveUrl?: string };
type CloudState = { profileId?: string; activeId?: string };
/** own: your Browser Use key. hosted: the free service. superpowers: your Superpowers account. */
export type CloudKind = 'own' | 'hosted' | 'superpowers';

/** Errors the user can act on (free limit reached, service paused). Shown as-is. */
export class CloudLimitError extends Error {}

const LOCAL_HINT = ' You can also use a local Chrome (set INSTINCT_BROWSER_PROVIDER to "local" in ~/.instinct/config.json) or your own Browser Use key.';
const SUPERPOWERS_HINT = ' To keep going now, sign in to Superpowers with: inskit superpowers login (new accounts get US$5 of credit, about 14 hours of browser).';

/**
 * Owns only this plugin's cloud browser. Other projects' sessions are never touched.
 * With an API key it talks to Browser Use directly. Otherwise a service keeps the key and the profile and hands back the
 * same CDP and live preview links: your Superpowers account after inskit superpowers login, or else the free hosted service.
 */
export class BrowserUseCloud {
  private state: CloudState;
  private path: string;
  private hostedPath: string;
  constructor(private cfg: Config, private request: typeof fetch = fetch) {
    this.hostedPath = join(cfg.home, 'hosted.json');
    // Separate state per account: a browser ID from one service means nothing to another.
    this.path = join(cfg.home, { own: 'browser-use.json', hosted: 'hosted-browser.json', superpowers: 'superpowers-browser.json' }[this.kind]);
    this.state = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
  }

  get kind(): CloudKind {
    if (this.cfg.browserUse?.superpowers) return 'superpowers';
    return !this.cfg.browserUse?.apiKey && this.cfg.browserUse?.hostedUrl ? 'hosted' : 'own';
  }
  get hosted() { return this.kind === 'hosted'; }
  /** A service keeps the Browser Use key and the profile. */
  get managed() { return this.kind !== 'own'; }

  private save() {
    mkdirSync(this.cfg.home, { recursive: true, mode: 0o700 });
    writeFileSync(this.path + '.tmp', JSON.stringify(this.state), { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
  }

  private async api(method: string, path: string, body: unknown) {
    if (this.managed) return this.serviceApi(method, path, body);
    const res = await this.request('https://api.browser-use.com/api/v4' + path, {
      method, headers: { 'X-Browser-Use-API-Key': this.cfg.browserUse!.apiKey!, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45_000),
    });
    if (method === 'PATCH' && [404, 410].includes(res.status)) return {};
    // Provider bodies and CDP URLs can contain credentials; never forward them to the model.
    if (!res.ok) throw new Error(`Browser Use Cloud ${method} ${path.split('/')[1]} failed (HTTP ${res.status}). Check credits, API key and session limits.`);
    return res.json() as Promise<any>;
  }

  /** Anonymous install token for the hosted service, created on first use and kept in <home>/hosted.json (0600). */
  private async hostedToken(): Promise<string> {
    if (existsSync(this.hostedPath)) {
      const saved = JSON.parse(readFileSync(this.hostedPath, 'utf8'));
      if (saved.url === this.cfg.browserUse!.hostedUrl && saved.token) return saved.token;
    }
    const res = await this.request(this.cfg.browserUse!.hostedUrl + '/v1/installs', { method: 'POST', signal: AbortSignal.timeout(20_000) });
    const body = await res.json().catch(() => ({})) as any;
    if (!res.ok || !body.token) throw new CloudLimitError(body.message || 'Could not register with the free cloud browser (HTTP ' + res.status + ').');
    mkdirSync(this.cfg.home, { recursive: true, mode: 0o700 });
    writeFileSync(this.hostedPath + '.tmp', JSON.stringify({ url: this.cfg.browserUse!.hostedUrl, id: body.id, token: body.token }), { mode: 0o600 });
    renameSync(this.hostedPath + '.tmp', this.hostedPath);
    return body.token;
  }

  private async serviceApi(method: string, path: string, body: unknown): Promise<any> {
    const sp = this.cfg.browserUse!.superpowers;
    const token = sp ? sp.apiKey : await this.hostedToken();
    const base = sp ? sp.url : this.cfg.browserUse!.hostedUrl;
    const res = await this.request(base + '/v1' + (sp && path === '/me' ? '/browsers/me' : path), {
      method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(path === '/browsers' ? { proxyCountry: (body as any)?.proxyCountryCode, timeoutMinutes: (body as any)?.timeout } : body),
      signal: AbortSignal.timeout(60_000),
    });
    const out = await res.json().catch(() => ({})) as any;
    if (method === 'PATCH' && [404, 410].includes(res.status)) return {};
    if (!res.ok) {
      const message = String(out.message ?? out.error ?? '').trim();
      if (sp) {
        // Superpowers explains balance and limit refusals itself, add-funds link included.
        if (res.status === 401) throw new CloudLimitError('Superpowers did not accept the saved key (' + (message || 'HTTP 401') + '). Sign in again with: inskit superpowers login');
        if ([402, 403, 409, 429, 503].includes(res.status) && message) throw new CloudLimitError('Superpowers cloud browser: ' + message);
        throw new Error('Superpowers cloud browser ' + method + ' failed (HTTP ' + res.status + '). Try again in a minute.');
      }
      // Out of free minutes or capacity: point to the paid path first, then the free alternatives.
      if ([429, 503].includes(res.status) && message) throw new CloudLimitError(message + SUPERPOWERS_HINT + LOCAL_HINT);
      if ([401, 403].includes(res.status) && message) throw new CloudLimitError(message + LOCAL_HINT);
      throw new Error('Free cloud browser ' + method + ' failed (HTTP ' + res.status + '). Try again in a minute.');
    }
    return out;
  }

  async start(): Promise<CloudSession> {
    // Reconcile a daemon crash before allocating another paid browser.
    await this.stop();
    // A service keeps one profile per install or account; with your own key the plugin creates and reuses its own.
    if (!this.managed && !this.state.profileId) {
      const profile = await this.api('POST', '/profiles', { name: `${BRAND} for Codex` });
      if (!profile.id) throw new Error('Browser Use did not return a profile ID.');
      this.state.profileId = profile.id;
      this.save();
    }
    const session = await this.api('POST', '/browsers', {
      profileId: this.state.profileId, proxyCountryCode: this.cfg.browserUse!.proxyCountry,
      timeout: this.cfg.browserUse!.timeoutMinutes, browserScreenWidth: 1280, browserScreenHeight: 900,
      enableRecording: false, metadata: { client: 'codex-instinct' },
    }) as CloudSession;
    if (!session.id) throw new Error('Browser Use did not return a browser ID.');
    this.state.activeId = session.id;
    this.save();
    if (!session.cdpUrl) { await this.stop(); throw new Error('Browser Use did not return a CDP connection.'); }
    return session;
  }

  async stop() {
    if (!this.state.activeId) return;
    await this.api('PATCH', `/browsers/${encodeURIComponent(this.state.activeId)}`, { action: 'stop' });
    delete this.state.activeId;
    this.save();
  }

  /** Free hosted service: today's usage and limits. Superpowers: this month's usage, balance and prices. */
  async usage(): Promise<any> {
    if (!this.managed) throw new Error('Usage is shown in your Browser Use dashboard when you use your own key.');
    return this.serviceApi('GET', '/me', undefined);
  }

  /** Stop the browser and delete the service's cloud profile with its cookies (and, on the free service, the install token). */
  async forget() {
    if (this.kind === 'hosted') {
      if (!existsSync(this.hostedPath)) return false;
      await this.serviceApi('DELETE', '/me', undefined);
      rmSync(this.hostedPath, { force: true });
      rmSync(this.path, { force: true });
      return true;
    }
    if (this.kind !== 'superpowers') throw new Error('With your own Browser Use key, delete profiles in your Browser Use dashboard.');
    const out = await this.serviceApi('DELETE', '/browsers/me', undefined);
    rmSync(this.path, { force: true });
    return !!out.forgotten;
  }
}
