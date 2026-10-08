import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { BRAND } from './brand.ts';

type CloudSession = { id: string; cdpUrl: string; liveUrl?: string };
type CloudState = { profileId?: string; activeId?: string };

/** Errors the user can act on (free limit reached, service paused). Shown as-is. */
export class CloudLimitError extends Error {}

/**
 * Owns only this plugin's cloud browser. Other projects' sessions are never touched.
 * With an API key it talks to Browser Use directly; without one it asks the free hosted service, which keeps the
 * key and the profile and hands back the same CDP and live preview links.
 */
export class BrowserUseCloud {
  private state: CloudState;
  private path: string;
  private hostedPath: string;
  constructor(private cfg: Config, private request: typeof fetch = fetch) {
    this.hostedPath = join(cfg.home, 'hosted.json');
    // Separate state per account: a browser ID from the hosted service means nothing to your own key, and back.
    this.path = join(cfg.home, this.hosted ? 'hosted-browser.json' : 'browser-use.json');
    this.state = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
  }

  get hosted() { return !this.cfg.browserUse?.apiKey && !!this.cfg.browserUse?.hostedUrl; }

  private save() {
    mkdirSync(this.cfg.home, { recursive: true, mode: 0o700 });
    writeFileSync(this.path + '.tmp', JSON.stringify(this.state), { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
  }

  private async api(method: string, path: string, body: unknown) {
    if (this.hosted) return this.hostedApi(method, path, body);
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

  private async hostedApi(method: string, path: string, body: unknown): Promise<any> {
    const token = await this.hostedToken();
    const res = await this.request(this.cfg.browserUse!.hostedUrl + '/v1' + path, {
      method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(path === '/browsers' ? { proxyCountry: (body as any)?.proxyCountryCode, timeoutMinutes: (body as any)?.timeout } : body),
      signal: AbortSignal.timeout(60_000),
    });
    const out = await res.json().catch(() => ({})) as any;
    if (method === 'PATCH' && [404, 410].includes(res.status)) return {};
    if (!res.ok) {
      if ([401, 403, 429, 503].includes(res.status) && out.message) {
        throw new CloudLimitError(out.message + ' Meanwhile you can use a local Chrome (set INSTINCT_BROWSER_PROVIDER to "local" in ~/.instinct/config.json) or your own Browser Use key.');
      }
      throw new Error('Free cloud browser ' + method + ' failed (HTTP ' + res.status + '). Try again in a minute.');
    }
    return out;
  }

  async start(): Promise<CloudSession> {
    // Reconcile a daemon crash before allocating another paid browser.
    await this.stop();
    // The hosted service keeps one profile per install; with your own key the plugin creates and reuses its own.
    if (!this.hosted && !this.state.profileId) {
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

  /** Hosted only: today's usage and limits for this install. */
  async hostedUsage(): Promise<{ id: string; today: { minutes: number; usd: number }; limits: { minutes_per_day: number; session_minutes: number } }> {
    return this.hostedApi('GET', '/me', undefined);
  }

  /** Hosted only: stop the browser, delete the cloud profile and its cookies, and drop the install token. */
  async hostedForget() {
    if (!existsSync(this.hostedPath)) return false;
    await this.hostedApi('DELETE', '/me', undefined);
    rmSync(this.hostedPath, { force: true });
    rmSync(this.path, { force: true });
    return true;
  }
}
