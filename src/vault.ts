import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import type { Envelope, Sealer } from './crypto.ts';
import { luhnValid } from './redact.ts';

export type VaultKind = 'card' | 'login' | 'identity';
export type RequestKind = VaultKind | 'cvv';

type CardSecret = { number: string; expMonth: string; expYear: string; holder: string; cvv?: string };
type LoginSecret = { username: string; password: string };
type IdentitySecret = { cpf?: string; birthDate?: string; document?: string };

export type VaultItemPublic = {
  id: string;
  kind: VaultKind;
  label: string;
  origin?: string;
  details: Record<string, string>;
};

export type LoginState = 'saved' | 'testing' | 'action_required' | 'verified' | 'failed';
export type LoginProgressStage = 'saved' | 'preparing' | 'opening_site' | 'entering_login' | 'entering_password' | 'waiting_site' | 'checking_result' | 'awaiting_code' | 'awaiting_app' | 'checking_code' | 'checking_app' | 'verified' | 'failed' | 'interrupted';
export type LoginFeedback = { state: LoginState; reason?: 'email_not_found' | 'incorrect_password' | 'verification_required' | 'unknown'; updatedAt: number; stage?: LoginProgressStage; events?: {stage: LoginProgressStage; at: number}[]; lastActivityAt?: number };
const PROGRESS_STAGES = new Set<LoginProgressStage>(['saved','preparing','opening_site','entering_login','entering_password','waiting_site','checking_result','awaiting_code','awaiting_app','checking_code','checking_app','verified','failed','interrupted']);

export type LoginChallenge = {
  id: string; itemId: string; session: string; origin: string;
  method: 'code' | 'app'; channel: 'sms' | 'email' | 'whatsapp' | 'authenticator' | 'app';
  instruction: string; error?: 'invalid_code'; expiresAt: number;
  status: 'pending' | 'ready' | 'consumed' | 'expired' | 'cancelled';
};

export type SecretRequest = {
  id: string;
  token: string;
  kind: RequestKind;
  purpose: string;
  origin?: string;
  itemId?: string;
  status: 'pending' | 'done' | 'expired';
  resultItemId?: string;
  createdAt: number;
  login?: LoginFeedback;
  retryId?: string;
  challengeId?: string;
  /** Last time the human's status page loaded or polled this request. In memory only. */
  viewedAt?: number;
};

/** Fields the agent may ask the vault to type. Values never leave the daemon except into a page field. */
export const FILLABLE: Record<RequestKind, string[]> = {
  card: ['number', 'expiry', 'expMonth', 'expYear', 'expYear2', 'expMonthYear4', 'holder', 'cvv'],
  cvv: ['cvv'],
  login: ['username', 'password'],
  identity: ['cpf', 'birthDate', 'document'],
};

const REQUEST_TTL_MS = 30 * 60_000;
const CVV_TTL_MS = 15 * 60_000;

export function hostOf(url: string) {
  try { return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Same site: hosts equal or one is a subdomain of the other (shop.com vs checkout.shop.com). */
export function sameSite(a: string, b: string) {
  const x = hostOf(a);
  const y = hostOf(b);
  if (!x || !y) return false;
  return x === y || x.endsWith('.' + y) || y.endsWith('.' + x) || siteOf(x) === siteOf(y);
}

/** Mercado Livre's observed first-party login redirects between these exact HTTPS hosts.
 * This alias is authentication-only; purchase/store matching stays unchanged. */
export function sameLoginSite(a: string, b: string) {
  if (sameSite(a, b)) return true;
  try {
    const x = new URL(a), y = new URL(b);
    const ml = new Set(['mercadolivre.com.br', 'www.mercadolivre.com.br', 'mercadolivre.com', 'www.mercadolivre.com']);
    return x.protocol === 'https:' && y.protocol === 'https:' && ml.has(x.hostname) && ml.has(y.hostname) && !x.port && !y.port;
  } catch { return false; }
}

const TWO_LEVEL = /\.(com|net|org|gov|edu|co|ac|art|blog|eco|ind|inf|log|med|mus|tur|app|dev)\.[a-z]{2}$/;
/** Registrable domain, approximately: amazon.com.br, google.com, checkout.shop.co.uk -> shop.co.uk. */
export function siteOf(host: string) {
  const h = host.replace(/^\./, '').toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || !h.includes('.')) return h;
  const parts = h.split('.');
  const n = TWO_LEVEL.test(h) ? 3 : 2;
  return parts.slice(-n).join('.');
}

export function generatePassword(length = 18, symbols = true) {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const sym = '@#!';
  const all = lower + upper + digits + (symbols ? sym : '');
  const n = Math.min(Math.max(length, 10), 40);
  const chars = [lower[randomInt(lower.length)], upper[randomInt(upper.length)], digits[randomInt(digits.length)]];
  if (symbols) chars.push(sym[randomInt(sym.length)]);
  while (chars.length < n) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

function cardBrand(number: string) {
  if (/^4/.test(number)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(number)) return 'Mastercard';
  if (/^3[47]/.test(number)) return 'Amex';
  if (/^(636368|438935|504175|451416|636297|5067|4576|4011|506699)/.test(number)) return 'Elo';
  if (/^(606282|3841)/.test(number)) return 'Hipercard';
  return 'Card';
}

export class Vault {
  private requests = new Map<string, SecretRequest>();
  private challenges = new Map<string, LoginChallenge>();
  private codes = new Map<string, string>();
  private cvvs = new Map<string, { value: string; expires: number }>();

  constructor(private db: Db, private sealer: Sealer) {
    const envelope = db.get<Envelope>('vault.login_requests.v1');
    if (envelope) {
      const saved = sealer.open<SecretRequest[]>(envelope, 'vault:login-requests:v1');
      for (const request of saved) {
        if (request.kind !== 'login' || Date.now() - request.createdAt > REQUEST_TTL_MS) continue;
        if (request.resultItemId && !this.item(request.resultItemId)) continue;
        delete request.challengeId; // Codes and challenge capabilities never survive restart.
        if (request.login && !['verified','failed'].includes(request.login.state)) {
          request.login.state = 'testing';
          this.setProgress(request, 'interrupted');
        }
        this.requests.set(request.token, request);
      }
      this.persistRequests();
    }
  }

  /** Only login metadata, sealed because the URL tokens are bearer capabilities. Never OTPs. */
  private persistRequests() {
    const saved = [...this.requests.values()]
      .filter(r => r.kind === 'login' && Date.now() - r.createdAt <= REQUEST_TTL_MS)
      .map(({id,token,kind,purpose,origin,itemId,status,resultItemId,createdAt,login,retryId}) =>
        ({id,token,kind,purpose,origin,itemId,status,resultItemId,createdAt,login,retryId}));
    this.db.set('vault.login_requests.v1', this.sealer.seal(saved, 'vault:login-requests:v1'));
  }

  private setProgress(request: SecretRequest, stage: LoginProgressStage) {
    const now = Date.now(), previous = request.login;
    const events = [...(previous?.events ?? [])];
    if (events.at(-1)?.stage !== stage) events.push({stage, at: now});
    request.login = {...previous, state: previous?.state ?? 'saved', updatedAt: now,
      stage, lastActivityAt: now, events: events.slice(-12)};
  }

  loginStatus(itemId: string) {
    return [...this.requests.values()].filter(r => r.resultItemId === itemId && !r.retryId && Date.now() - r.createdAt <= REQUEST_TTL_MS).at(-1)?.login;
  }

  markViewed(request: SecretRequest) {
    request.viewedAt = Date.now();
  }

  /** True when a status page for this login polled recently, so a challenge shown there will be seen. */
  loginPageOpen(itemId: string, withinMs = 15_000) {
    return [...this.requests.values()].some(r => r.kind === 'login' && r.resultItemId === itemId && !r.retryId
      && Date.now() - r.createdAt <= REQUEST_TTL_MS && r.viewedAt !== undefined && Date.now() - r.viewedAt <= withinMs);
  }

  loginProgress(itemId: string, stage: LoginProgressStage) {
    if (!PROGRESS_STAGES.has(stage)) throw new Error('Invalid login progress stage.');
    for (const r of this.requests.values()) {
      if (r.kind === 'login' && r.resultItemId === itemId && !r.retryId && Date.now() - r.createdAt <= REQUEST_TTL_MS) this.setProgress(r, stage);
    }
    this.persistRequests();
  }

  list(): VaultItemPublic[] {
    const rows = this.db.sql.prepare('select id, kind, label, origin, public from vault_items order by updated_at desc').all() as any[];
    return rows.map(r => ({ id: r.id, kind: r.kind, label: r.label, origin: r.origin ?? undefined, details: JSON.parse(r.public) }));
  }

  item(id: string) {
    return this.list().find(i => i.id === id);
  }

  remove(id: string) {
    this.db.sql.prepare('delete from vault_items where id = ?').run(id);
    this.cvvs.delete(id);
    for (const [token, r] of this.requests) if (r.resultItemId === id || r.itemId === id) {
      if (r.challengeId) this.cancelChallenge(r.challengeId);
      this.requests.delete(token);
    }
    this.persistRequests();
    this.db.audit('vault.removed', { id });
  }

  private save(kind: VaultKind, label: string, origin: string | undefined, details: Record<string, string>, secret: unknown, id = 'v_' + randomUUID().slice(0, 8)) {
    const now = Date.now();
    const envelope = this.sealer.seal(secret, `vault:${id}:${kind}`);
    this.db.sql.prepare(`insert into vault_items (id, kind, label, origin, public, envelope, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(id) do update set label = excluded.label, public = excluded.public,
      envelope = excluded.envelope, updated_at = excluded.updated_at`)
      .run(id, kind, label, origin ?? null, JSON.stringify(details), JSON.stringify(envelope), now, now);
    this.db.audit('vault.saved', { id, kind, label, origin });
    return id;
  }

  private secret<T>(id: string): { kind: VaultKind; origin?: string; value: T } {
    const row = this.db.sql.prepare('select kind, origin, envelope from vault_items where id = ?').get(id) as any;
    if (!row) throw new Error('Vault item not found');
    return { kind: row.kind, origin: row.origin ?? undefined, value: this.sealer.open<T>(JSON.parse(row.envelope) as Envelope, `vault:${id}:${row.kind}`) };
  }

  createRequest(input: { kind: RequestKind; purpose: string; origin?: string; itemId?: string }) {
    if (input.kind === 'login' && !input.origin) throw new Error('A login request needs the site URL (origin).');
    if (input.kind === 'cvv') {
      const card = input.itemId ? this.item(input.itemId) : undefined;
      if (!card || card.kind !== 'card') throw new Error('A CVV request needs item_id of a saved card.');
    }
    const request: SecretRequest = {
      id: 'req_' + randomBytes(6).toString('hex'),
      token: randomBytes(24).toString('base64url'),
      kind: input.kind, purpose: input.purpose.slice(0, 300), origin: input.origin, itemId: input.itemId,
      status: 'pending', createdAt: Date.now(),
    };
    this.requests.set(request.token, request);
    if (request.kind === 'login') this.persistRequests();
    this.db.audit('vault.request', { id: request.id, kind: request.kind, origin: request.origin, itemId: request.itemId });
    return request;
  }

  requestByToken(token: string) {
    const request = this.requests.get(token);
    if (!request) return undefined;
    if (request.status === 'pending' && Date.now() - request.createdAt > REQUEST_TTL_MS) request.status = 'expired';
    return request;
  }

  requestById(id: string) {
    const request = [...this.requests.values()].find(r => r.id === id);
    return request ? this.requestByToken(request.token) : undefined;
  }

  latestRequest(id: string): SecretRequest | undefined {
    const r = this.requestById(id);
    return r?.retryId ? this.latestRequest(r.retryId) : r;
  }

  retryLogin(token: string) {
    const old = this.requestByToken(token);
    if (!old || old.kind !== 'login' || old.login?.state !== 'failed' || Date.now() - old.createdAt > REQUEST_TTL_MS) throw new Error('This login cannot be retried. Ask for a new link.');
    if (old.retryId) return this.latestRequest(old.id)!;
    const next = this.createRequest({ kind: 'login', origin: old.origin, purpose: old.purpose });
    old.retryId = next.id;
    this.persistRequests();
    return next;
  }

  loginFeedback(itemId: string, feedback: Omit<LoginFeedback, 'updatedAt'>) {
    const item = this.item(itemId);
    if (!item || item.kind !== 'login') throw new Error('A saved login is required.');
    if (!['saved','testing','action_required','verified','failed'].includes(feedback.state)) throw new Error('Invalid login state.');
    if ([...this.requests.values()].some(r => r.resultItemId === itemId && r.retryId)) throw new Error('This login was replaced. Wait for the corrected credentials.');
    let requests = [...this.requests.values()].filter(r => r.kind === 'login' && r.resultItemId === itemId && !r.retryId && Date.now() - r.createdAt <= REQUEST_TTL_MS);
    if (!requests.length) {
      const r = this.createRequest({ kind: 'login', origin: item.origin, purpose: 'Verificar login' });
      r.status = 'done'; r.resultItemId = itemId;
      requests = [r];
    }
    for (const r of requests) {
      if (r.challengeId && feedback.state !== 'action_required') this.cancelChallenge(r.challengeId);
      const previous = r.login;
      r.login = { ...previous, ...feedback, updatedAt: Date.now() };
      const stage: LoginProgressStage = feedback.state === 'verified' ? 'verified' : feedback.state === 'failed' ? 'failed'
        : feedback.state === 'saved' ? 'saved' : feedback.state === 'action_required' ? 'waiting_site'
        : previous?.state === 'testing' && previous.stage && previous.stage !== 'interrupted' ? previous.stage : 'preparing';
      this.setProgress(r, stage);
    }
    this.persistRequests();
    this.db.audit('vault.login_feedback', { itemId, state: feedback.state, reason: feedback.reason });
    return requests.at(-1)!;
  }

  private cancelChallenge(id: string) {
    this.codes.delete(id);
    const c = this.challenges.get(id);
    if (c) c.status = 'cancelled';
  }

  createChallenge(itemId: string, session: string, origin: string, input: {
    method: LoginChallenge['method']; channel: LoginChallenge['channel']; instruction: string;
    expires_seconds?: number; error?: 'invalid_code';
  }) {
    const item = this.item(itemId);
    if (item?.kind !== 'login' || !sameLoginSite(item.origin ?? '', origin)) throw new Error('Challenge must belong to the login site.');
    if (!['code','app'].includes(input.method) || !['sms','email','whatsapp','authenticator','app'].includes(input.channel)) throw new Error('Invalid challenge method.');
    if ((input.method === 'app') !== (input.channel === 'app')) throw new Error('App approval uses the app channel.');
    if (typeof input.instruction !== 'string' || !input.instruction.trim() || input.instruction.length > 240) throw new Error('Give a short instruction without credentials.');
    const r = this.loginFeedback(itemId, { state: 'action_required', reason: 'verification_required' });
    for (const old of this.challenges.values()) if (old.itemId === itemId) this.cancelChallenge(old.id);
    const c: LoginChallenge = { id: 'challenge_' + randomBytes(12).toString('hex'), itemId, session,
      origin: new URL(origin).origin, method: input.method, channel: input.channel,
      instruction: input.instruction, error: input.error, status: 'pending',
      expiresAt: Date.now() + Math.min(600, Math.max(30, input.expires_seconds ?? 300)) * 1000 };
    this.challenges.set(c.id, c);
    for (const req of this.requests.values()) if (req.resultItemId === itemId && !req.retryId) req.challengeId = c.id;
    this.loginProgress(itemId, c.method === 'code' ? 'awaiting_code' : 'awaiting_app');
    this.db.audit('vault.challenge_created', { id: c.id, itemId, method: c.method });
    const timer = setTimeout(() => this.challenge(c.id), c.expiresAt - Date.now() + 10);
    timer.unref();
    return { request: r, challenge: c };
  }

  challenge(id: string) {
    const c = this.challenges.get(id);
    if (c && Date.now() >= c.expiresAt && ['pending','ready'].includes(c.status)) {
      c.status = 'expired'; this.codes.delete(id);
    }
    return c;
  }

  publicChallenge(id?: string) {
    const c = id ? this.challenge(id) : undefined;
    if (!c || c.status === 'cancelled') return undefined;
    const { method, channel, instruction, error, expiresAt, status } = c;
    return { id: c.id, method, channel, instruction, error, expiresAt, status };
  }

  submitChallenge(token: string, id: string, form: Record<string, string>) {
    const r = this.requestByToken(token), c = this.challenge(id);
    if (!r || r.status !== 'done' || r.retryId || r.challengeId !== id || Date.now() - r.createdAt > REQUEST_TTL_MS || !c || c.status !== 'pending') throw new Error('Esta verificação já foi enviada ou expirou. Aguarde uma nova tentativa.');
    if (c.method === 'code') {
      const code = (form.code ?? '').trim();
      if (!/^[a-zA-Z0-9-]{3,32}$/.test(code)) throw new Error('Confira o código recebido e tente novamente.');
      this.codes.set(id, code);
    } else if (form.confirmed !== 'yes') throw new Error('Confirme a aprovação no aplicativo primeiro.');
    c.status = 'ready';
    for (const request of this.requests.values()) {
      if (request.resultItemId === c.itemId && !request.retryId) {
        request.login = {...request.login, state: 'testing', updatedAt: Date.now()};
        this.setProgress(request, c.method === 'code' ? 'checking_code' : 'checking_app');
      }
    }
    this.persistRequests();
    this.db.audit('vault.challenge_received', { id, method: c.method });
  }

  /** The agent found the code itself (e.g. in the user's email, or the user pasted it). Never stored outside memory or logged. */
  provideChallengeCode(id: string, session: string, code: string, source: string) {
    const c = this.challengeForSession(id, session);
    if (c.method !== 'code' || c.status !== 'pending') throw new Error(`Challenge ${c.status}; request a fresh one if the site still asks for a code.`);
    const value = code.replace(/\s+/g, '');
    if (!/^[a-zA-Z0-9-]{3,32}$/.test(value)) throw new Error('That does not look like a verification code.');
    this.codes.set(id, value);
    c.status = 'ready';
    for (const request of this.requests.values()) {
      if (request.resultItemId === c.itemId && !request.retryId) {
        request.login = { ...request.login!, state: 'testing', updatedAt: Date.now() };
        this.setProgress(request, 'checking_code');
      }
    }
    this.persistRequests();
    this.db.audit('vault.challenge_received', { id, method: c.method, source });
  }

  challengeForSession(id: string, session: string) {
    const c = this.challenge(id);
    if (!c || c.session !== session) throw new Error('Unknown challenge for this session.');
    return c;
  }

  takeChallengeCode(id: string, session: string, pageUrl: string) {
    const c = this.challengeForSession(id, session);
    if (new URL(pageUrl).origin !== c.origin) throw new Error('The code can only be filled on the challenge origin.');
    if (c.method !== 'code' || c.status !== 'ready') throw new Error('No code ready, or it was already used or expired.');
    const value = this.codes.get(id);
    if (!value) throw new Error('No code ready.');
    this.codes.delete(id); c.status = 'consumed';
    return value;
  }

  /** Called by the vault web page. Returns the stored item id (or the card id for a CVV). */
  submit(token: string, form: Record<string, string>) {
    const request = this.requestByToken(token);
    if (!request || request.status !== 'pending') throw new Error('This link was already used or expired.');
    const f = (k: string) => (form[k] ?? '').trim();
    let itemId: string;
    switch (request.kind) {
      case 'card': {
        const number = f('number').replace(/\D/g, '');
        if (!luhnValid(number)) throw new Error('Invalid card number.');
        const exp = f('expiry').replace(/\s/g, '').match(/^(\d{1,2})\/?(\d{2}|\d{4})$/);
        if (!exp) throw new Error('Invalid expiry. Use MM/YY.');
        const expMonth = exp[1].padStart(2, '0');
        const expYear = exp[2].length === 2 ? '20' + exp[2] : exp[2];
        if (Number(expMonth) < 1 || Number(expMonth) > 12) throw new Error('Invalid expiry month.');
        const holder = f('holder').toUpperCase();
        if (holder.length < 3) throw new Error('Enter the name as printed on the card.');
        const cvv = f('cvv');
        if (cvv && !/^\d{3,4}$/.test(cvv)) throw new Error('CVV must have 3 or 4 digits.');
        const rememberCvv = !!cvv && (form.rememberCvv === 'on' || form.rememberCvv === 'true');
        const brand = cardBrand(number);
        const last4 = number.slice(-4);
        const label = f('label') || `${brand} ending ${last4}`;
        itemId = this.save('card', label, undefined, { brand, last4, expiry: `${expMonth}/${expYear.slice(2)}`, holder, cvv: rememberCvv ? 'saved' : 'asked per purchase' },
          { number, expMonth, expYear, holder, cvv: rememberCvv ? cvv : undefined } satisfies CardSecret);
        // A CVV typed without "remember" is kept in memory for this purchase only.
        if (cvv && !rememberCvv) this.cvvs.set(itemId, { value: cvv, expires: Date.now() + CVV_TTL_MS });
        break;
      }
      case 'cvv': {
        const cvv = f('cvv');
        if (!/^\d{3,4}$/.test(cvv)) throw new Error('CVV must have 3 or 4 digits.');
        itemId = request.itemId!;
        this.cvvs.set(itemId, { value: cvv, expires: Date.now() + CVV_TTL_MS });
        break;
      }
      case 'login': {
        const username = f('username');
        const password = form.password ?? '';
        if (!username || !password) throw new Error('Enter username and password.');
        const site = hostOf(request.origin!);
        itemId = this.save('login', `Login ${site}`, request.origin, { site, username }, { username, password } satisfies LoginSecret);
        break;
      }
      case 'identity': {
        const cpf = f('cpf').replace(/\D/g, '');
        if (cpf && cpf.length !== 11) throw new Error('CPF must have 11 digits.');
        const birthDate = f('birthDate');
        const document = f('document');
        if (!cpf && !document) throw new Error('Enter a CPF or another document number.');
        itemId = this.save('identity', 'Identity', undefined, {
          cpf: cpf ? `***.***.***-${cpf.slice(-2)}` : 'not set', document: document ? `…${document.slice(-2)}` : 'not set', birthDate: birthDate ? 'set' : 'not set',
        }, { cpf: cpf || undefined, birthDate: birthDate || undefined, document: document || undefined } satisfies IdentitySecret);
        break;
      }
    }
    request.status = 'done';
    request.resultItemId = itemId;
    if (request.kind === 'login') {
      request.login = {state:'saved', updatedAt:Date.now()};
      this.setProgress(request, 'saved');
      this.persistRequests();
    }
    this.db.audit('vault.submitted', { id: request.id, kind: request.kind, itemId });
    return { request, itemId };
  }

  generateLogin(origin: string, username: string, length?: number, symbols?: boolean) {
    const site = hostOf(origin);
    if (!site) throw new Error('Invalid origin.');
    const password = generatePassword(length, symbols);
    return this.save('login', `Login ${site}`, origin, { site, username, generated: 'yes' }, { username, password } satisfies LoginSecret);
  }

  /**
   * Resolves a secret value for typing into a page at pageUrl. Logins are bound to their site.
   * A CVV entered per purchase is single use.
   */
  valueForFill(itemId: string, field: string, pageUrl: string): string {
    const { kind, origin, value } = this.secret<any>(itemId);
    if (!FILLABLE[kind].includes(field)) throw new Error(`Field ${field} does not exist for ${kind}. Options: ${FILLABLE[kind].join(', ')}`);
    if (kind === 'login' && origin && !sameLoginSite(origin, pageUrl)) throw new Error(`This login belongs to ${hostOf(origin)} and the page is ${hostOf(pageUrl)}. Refusing to fill it on another site.`);
    if (kind === 'card') {
      const card = value as CardSecret;
      if (field === 'cvv') {
        const once = this.cvvs.get(itemId);
        if (once && once.expires > Date.now()) { this.cvvs.delete(itemId); return once.value; }
        if (card.cvv) return card.cvv;
        throw new Error('No CVV saved for this card. Ask with vault_request kind=cvv.');
      }
      if (field === 'expiry') return `${card.expMonth}/${card.expYear.slice(2)}`;
      if (field === 'expYear2') return card.expYear.slice(2);
      if (field === 'expMonthYear4') return `${card.expMonth}/${card.expYear}`;
    }
    const out = value[field];
    if (typeof out !== 'string' || !out) throw new Error('That field is empty in the vault.');
    return out;
  }
}
