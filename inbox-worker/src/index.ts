// Catch-all inbox for the agent. Email Routing hands every message for @<DOMAIN> to email(); inskit reads them over
// GET /v1/messages with a bearer token. A message is never rejected: a bounced verification mail can get the address
// flagged by the sender, so failures are logged instead.
import PostalMime from 'postal-mime';
import { DurableObject } from 'cloudflare:workers';

type Env = { INBOX: DurableObjectNamespace<Inbox>; INBOX_TOKEN: string; DOMAIN: string };
type Mail = { id: string; to: string; from: string; fromName: string | null; subject: string; text: string; html: string; messageId: string | null; receivedAt: number };

const KEEP_MS = 30 * 86400_000;

export class Inbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`create table if not exists mail (id text primary key, to_addr text not null, from_addr text not null,
      from_name text, subject text not null, text text not null, html text not null, message_id text, received_at integer not null)`);
    ctx.storage.sql.exec('create index if not exists mail_received on mail (received_at)');
  }

  add(m: Mail) {
    const sql = this.ctx.storage.sql;
    if (m.messageId && sql.exec('select 1 from mail where message_id = ? and to_addr = ?', m.messageId, m.to).toArray().length) return;
    sql.exec('insert into mail values (?, ?, ?, ?, ?, ?, ?, ?, ?)', m.id, m.to, m.from, m.fromName, m.subject, m.text, m.html, m.messageId, m.receivedAt);
    sql.exec('delete from mail where received_at < ?', Date.now() - KEEP_MS);
  }

  list(to: string | null, since: number, limit: number) {
    const rows = to
      ? this.ctx.storage.sql.exec('select * from mail where to_addr = ? and received_at >= ? order by received_at desc limit ?', to, since, limit)
      : this.ctx.storage.sql.exec('select * from mail where received_at >= ? order by received_at desc limit ?', since, limit);
    return rows.toArray().map(r => ({ id: r.id, to: r.to_addr, from: r.from_addr, fromName: r.from_name, subject: r.subject,
      text: r.text, html: r.html, receivedAt: r.received_at }));
  }
}

const inbox = (env: Env) => env.INBOX.get(env.INBOX.idFromName('main'));

function authorized(req: Request, env: Env) {
  const given = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!env.INBOX_TOKEN || given.length !== env.INBOX_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ env.INBOX_TOKEN.charCodeAt(i);
  return diff === 0;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env) {
    try {
      const parsed = await PostalMime.parse(message.raw);
      await inbox(env).add({
        id: 'm_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        to: message.to.toLowerCase(),
        from: (parsed.from?.address || message.from).toLowerCase(),
        fromName: parsed.from?.name || null,
        subject: (parsed.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        text: (parsed.text ?? '').slice(0, 50_000),
        html: (parsed.html ?? '').slice(0, 300_000),
        messageId: parsed.messageId ?? null,
        receivedAt: Date.now(),
      });
    } catch (error) {
      console.error('inbox: could not store message', message.from, '->', message.to, error);
    }
  },

  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true, domain: env.DOMAIN });
    if (url.pathname !== '/v1/messages' || req.method !== 'GET') return new Response('not found', { status: 404 });
    if (!authorized(req, env)) return new Response('unauthorized', { status: 401 });
    const to = url.searchParams.get('to')?.toLowerCase() || null;
    const since = Number(url.searchParams.get('since') || 0) || 0;
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20)));
    return Response.json({ messages: await inbox(env).list(to, since, limit) });
  },
} satisfies ExportedHandler<Env>;

