// Hosted cloud browsers for the plugin. The Worker keeps one Browser Use API key and opens, stops and accounts
// for browsers on behalf of anonymous installs. Browsing traffic goes straight from the user's machine to the
// browser over CDP; it never passes through here. The landing page and install script are static assets.
import { DurableObject } from 'cloudflare:workers';

type Env = {
  LEDGER: DurableObjectNamespace<Ledger>;
  ASSETS: Fetcher;
  BROWSER_USE_API_KEY: string;
  /** "0" pauses new browsers without a code change. */
  SERVICE_ENABLED?: string;
  DAILY_BUDGET_USD?: string;
  INSTALL_DAILY_USD?: string;
  INSTALL_DAILY_MINUTES?: string;
  MAX_ACTIVE?: string;
  MAX_SESSION_MINUTES?: string;
  INSTALLS_PER_IP_PER_DAY?: string;
  /** Bearer token for GET /v1/stats (wrangler secret put ADMIN_TOKEN). */
  ADMIN_TOKEN?: string;
};

type Session = { id: string; install_id: string; started_at: number; timeout_at: number; finished_at: number | null; cost_usd: number; proxy_mb: number };
type Install = { id: string; profile_id: string | null; blocked: number };

const API = 'https://api.browser-use.com/api/v4';
const DAY = 86400_000;
const BROWSER_USD_PER_HOUR = 0.02;
const dayStart = (now = Date.now()) => now - (now % DAY);

export function limits(env: Partial<Env>) {
  const n = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    dailyBudget: n(env.DAILY_BUDGET_USD, 10),
    installDailyUsd: n(env.INSTALL_DAILY_USD, 0.5),
    installDailyMinutes: n(env.INSTALL_DAILY_MINUTES, 60),
    maxActive: n(env.MAX_ACTIVE, 10),
    maxSessionMinutes: n(env.MAX_SESSION_MINUTES, 30),
    installsPerIp: n(env.INSTALLS_PER_IP_PER_DAY, 20),
  };
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const fail = (status: number, error: string, message: string) => json({ error, message }, status);

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return 'ik_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** One ledger for the whole service. Durable Object calls are serialized, so quotas cannot race. */
export class Ledger extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('create table if not exists installs (id text primary key, token_hash text unique not null, profile_id text, created_at integer not null, ip_hash text not null, blocked integer not null default 0)');
    this.sql.exec('create index if not exists installs_ip on installs (ip_hash, created_at)');
    this.sql.exec('create table if not exists sessions (id text primary key, install_id text not null, started_at integer not null, timeout_at integer not null, finished_at integer, cost_usd real not null default 0, proxy_mb real not null default 0)');
    this.sql.exec('create index if not exists sessions_install on sessions (install_id, started_at)');
    this.sql.exec('create index if not exists sessions_open on sessions (finished_at)');
    // Provider costs (proxy traffic above all) are finalized minutes after a browser stops; recheck until final.
    try { this.sql.exec('alter table sessions add column final integer not null default 0'); } catch { /* already there */ }
  }

  private async api(method: string, path: string, body?: unknown) {
    const res = await fetch(API + path, {
      method,
      headers: { 'X-Browser-Use-API-Key': this.env.BROWSER_USE_API_KEY, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      if ((method === 'PATCH' || method === 'DELETE') && [404, 410].includes(res.status)) return {};
      console.error('browser-use', method, path.split('/')[1], res.status);
      throw new Error('provider ' + res.status);
    }
    return res.json() as Promise<any>;
  }

  async register(ipHash: string) {
    const lim = limits(this.env);
    const recent = this.sql.exec('select count(*) as n from installs where ip_hash = ? and created_at > ?', ipHash, Date.now() - DAY).one().n as number;
    if (recent >= lim.installsPerIp) return fail(429, 'too_many_installs', 'Too many new installs from this network today. Try again tomorrow.');
    const token = randomToken();
    const id = 'in_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    this.sql.exec('insert into installs (id, token_hash, created_at, ip_hash) values (?, ?, ?, ?)', id, await sha256(token), Date.now(), ipHash);
    return json({ id, token });
  }

  private async install(token: string) {
    return this.sql.exec('select id, profile_id, blocked from installs where token_hash = ?', await sha256(token)).toArray()[0] as unknown as Install | undefined;
  }

  private openSessions(installId?: string) {
    return (installId
      ? this.sql.exec('select * from sessions where install_id = ? and finished_at is null', installId)
      : this.sql.exec('select * from sessions where finished_at is null')).toArray() as unknown as Session[];
  }

  /** Close the books on a session with the provider's real cost. Returns false if it is still running. */
  private async settle(s: Session, force = false) {
    let cost = 0, mb = 0, finished = Date.now();
    try {
      const b = await this.api('GET', '/browsers/' + encodeURIComponent(s.id));
      if (!force && b.status === 'active') return false;
      cost = Number(b.browserCost ?? 0) + Number(b.proxyCost ?? 0);
      mb = Number(b.proxyUsedMb ?? 0);
      if (b.finishedAt) finished = Date.parse(b.finishedAt);
    } catch {
      // Unknown to the provider: charge the worst case so quotas stay conservative.
      cost = ((s.timeout_at - s.started_at) / 3600_000) * BROWSER_USD_PER_HOUR;
      finished = s.timeout_at;
    }
    this.sql.exec('update sessions set finished_at = ?, cost_usd = ?, proxy_mb = ? where id = ?', finished, cost, mb, s.id);
    return true;
  }

  private async stopSession(s: Session) {
    await this.api('PATCH', '/browsers/' + encodeURIComponent(s.id), { action: 'stop' }).catch(() => {});
    await this.settle(s, true);
  }

  /**
   * Cron: settle sessions that passed their timeout or that the user's daemon never stopped, and refresh the cost
   * of recently closed ones until the provider has finished billing them (15 minutes after they stop).
   */
  async reconcile() {
    for (const s of this.openSessions()) if (s.timeout_at <= Date.now() + 60_000) await this.settle(s);
    const closed = this.sql.exec('select * from sessions where finished_at is not null and final = 0 limit 200').toArray() as unknown as Session[];
    for (const s of closed) {
      try {
        const b = await this.api('GET', '/browsers/' + encodeURIComponent(s.id));
        const cost = Number(b.browserCost ?? 0) + Number(b.proxyCost ?? 0);
        const final = Date.now() - (s.finished_at ?? 0) > 15 * 60_000 ? 1 : 0;
        this.sql.exec('update sessions set cost_usd = max(cost_usd, ?), proxy_mb = max(proxy_mb, ?), final = ? where id = ?', cost, Number(b.proxyUsedMb ?? 0), final, s.id);
      } catch {
        if (Date.now() - (s.finished_at ?? 0) > 60 * 60_000) this.sql.exec('update sessions set final = 1 where id = ?', s.id);
      }
    }
  }

  private usage(installId?: string) {
    const since = dayStart();
    const rows = (installId
      ? this.sql.exec('select * from sessions where install_id = ? and started_at >= ?', installId, since)
      : this.sql.exec('select * from sessions where started_at >= ?', since)).toArray() as unknown as Session[];
    let usd = 0, minutes = 0;
    for (const r of rows) {
      const end = r.finished_at ?? Math.min(Date.now(), r.timeout_at);
      minutes += (end - r.started_at) / 60_000;
      // Open sessions: estimate browser time only; proxy traffic is billed when they close.
      usd += r.finished_at ? r.cost_usd : ((end - r.started_at) / 3600_000) * BROWSER_USD_PER_HOUR;
    }
    return { usd, minutes };
  }

  async me(token: string) {
    const inst = await this.install(token);
    if (!inst) return fail(401, 'unknown_install', 'Unknown install token.');
    const lim = limits(this.env);
    const u = this.usage(inst.id);
    return json({
      id: inst.id,
      today: { minutes: Math.round(u.minutes), usd: Number(u.usd.toFixed(4)) },
      limits: { minutes_per_day: lim.installDailyMinutes, usd_per_day: lim.installDailyUsd, session_minutes: lim.maxSessionMinutes },
    });
  }

  async start(token: string, body: { proxyCountry?: string; timeoutMinutes?: number }) {
    const inst = await this.install(token);
    if (!inst) return fail(401, 'unknown_install', 'Unknown install token.');
    if (inst.blocked) return fail(403, 'blocked', 'This install was disabled.');
    if (this.env.SERVICE_ENABLED === '0') return fail(503, 'paused', 'The free cloud browser is paused right now.');
    const lim = limits(this.env);
    // One browser per install: a new start replaces the previous one.
    for (const s of this.openSessions(inst.id)) await this.stopSession(s);
    // Only expired open sessions here; refreshing closed sessions' costs is the cron's job and would slow a start.
    for (const s of this.openSessions()) if (s.timeout_at <= Date.now()) await this.settle(s);
    const mine = this.usage(inst.id), all = this.usage();
    if (mine.minutes >= lim.installDailyMinutes || mine.usd >= lim.installDailyUsd)
      return fail(429, 'install_quota', 'Daily free limit reached (' + lim.installDailyMinutes + ' browser minutes). It resets at 00:00 UTC.');
    if (all.usd >= lim.dailyBudget) return fail(503, 'service_budget', 'The free cloud browser reached its budget for today. It resets at 00:00 UTC.');
    if (this.openSessions().length >= lim.maxActive) return fail(503, 'busy', 'All free cloud browsers are busy. Try again in a few minutes.');

    let profileId = inst.profile_id;
    if (!profileId) {
      const p = await this.api('POST', '/profiles', { name: 'hosted ' + inst.id });
      if (!p.id) return fail(502, 'provider', 'The cloud browser could not be started.');
      profileId = String(p.id);
      this.sql.exec('update installs set profile_id = ? where id = ?', profileId, inst.id);
    }
    const proxy = /^[a-z]{2}$/.test(body.proxyCountry ?? '') ? body.proxyCountry : 'br';
    const minutes = Math.max(5, Math.min(lim.maxSessionMinutes, Math.floor(Number(body.timeoutMinutes) || lim.maxSessionMinutes)));
    const b = await this.api('POST', '/browsers', {
      profileId, proxyCountryCode: proxy, timeout: minutes, browserScreenWidth: 1280, browserScreenHeight: 900,
      enableRecording: false, metadata: { install: inst.id },
    });
    if (!b.id || !b.cdpUrl) {
      if (b.id) await this.api('PATCH', '/browsers/' + encodeURIComponent(b.id), { action: 'stop' }).catch(() => {});
      return fail(502, 'provider', 'The cloud browser could not be started.');
    }
    const now = Date.now();
    this.sql.exec('insert into sessions (id, install_id, started_at, timeout_at) values (?, ?, ?, ?)', b.id, inst.id, now, now + minutes * 60_000);
    return json({ id: b.id, cdpUrl: b.cdpUrl, liveUrl: b.liveUrl ?? null, timeoutMinutes: minutes });
  }

  async stop(token: string, id: string) {
    const inst = await this.install(token);
    if (!inst) return fail(401, 'unknown_install', 'Unknown install token.');
    const s = this.sql.exec('select * from sessions where id = ? and install_id = ?', id, inst.id).toArray()[0] as unknown as Session | undefined;
    if (s && s.finished_at === null) await this.stopSession(s);
    return json({ ok: true });
  }

  /** Forget an install: stop its browser and delete its cloud profile and cookies. */
  async forget(token: string) {
    const inst = await this.install(token);
    if (!inst) return json({ ok: true });
    for (const s of this.openSessions(inst.id)) await this.stopSession(s);
    if (inst.profile_id) await this.api('DELETE', '/profiles/' + encodeURIComponent(inst.profile_id)).catch(() => {});
    this.sql.exec('update installs set profile_id = null, blocked = 1, token_hash = ? where id = ?', 'deleted:' + inst.id, inst.id);
    return json({ ok: true });
  }

  /** Operator view: installs, open browsers and today's spend against the budget. */
  async stats() {
    const lim = limits(this.env);
    const today = this.usage();
    const since = dayStart();
    const count = (q: string, ...a: unknown[]) => this.sql.exec(q, ...a).one().n as number;
    return json({
      installs_total: count('select count(*) as n from installs'),
      installs_today: count('select count(*) as n from installs where created_at >= ?', since),
      active_installs_today: count('select count(distinct install_id) as n from sessions where started_at >= ?', since),
      sessions_today: count('select count(*) as n from sessions where started_at >= ?', since),
      open_browsers: this.openSessions().length,
      today_usd: Number(today.usd.toFixed(4)),
      today_minutes: Math.round(today.minutes),
      budget_usd: lim.dailyBudget,
      proxy_mb_today: Number((this.sql.exec('select coalesce(sum(proxy_mb), 0) as n from sessions where started_at >= ?', since).one().n as number).toFixed(1)),
    });
  }
}

const ledger = (env: Env) => env.LEDGER.get(env.LEDGER.idFromName('main'));
const bearer = (req: Request) => (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

/** Re-wrap a Durable Object reply: a streamed RPC body can arrive empty once the edge compresses it. */
async function relay(reply: Promise<Response>) {
  const r = await reply;
  return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const l = ledger(env);
  const path = url.pathname;
  if (path === '/v1/health') return json({ ok: true, enabled: env.SERVICE_ENABLED !== '0' });
  if (path === '/v1/installs' && req.method === 'POST') return l.register(await sha256('ip:' + (req.headers.get('cf-connecting-ip') ?? 'unknown')));
  const token = bearer(req);
  if (path === '/v1/stats' && req.method === 'GET') {
    if (!env.ADMIN_TOKEN || (await sha256(token)) !== (await sha256(env.ADMIN_TOKEN))) return fail(401, 'unauthorized', 'Admin token required.');
    return l.stats();
  }
  if (!token.startsWith('ik_')) return fail(401, 'unauthorized', 'Missing install token.');
  if (path === '/v1/me' && req.method === 'GET') return l.me(token);
  if (path === '/v1/me' && req.method === 'DELETE') return l.forget(token);
  if (path === '/v1/browsers' && req.method === 'POST') {
    const body = await req.json().catch(() => ({})) as { proxyCountry?: string; timeoutMinutes?: number };
    return l.start(token, body).catch(() => fail(502, 'provider', 'The cloud browser could not be started.'));
  }
  const m = path.match(/^\/v1\/browsers\/([\w-]+)$/);
  if (m && (req.method === 'PATCH' || req.method === 'DELETE')) return l.stop(token, m[1]);
  return fail(404, 'not_found', 'Not found.');
}

async function api(req: Request, env: Env, url: URL): Promise<Response> {
  return relay(route(req, env, url));
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/v1/')) return api(req, env, url);
    return env.ASSETS.fetch(req);
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    await ledger(env).reconcile();
  },
} satisfies ExportedHandler<Env>;
