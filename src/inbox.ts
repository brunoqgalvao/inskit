// The agent's own mailbox (catch-all on your domain, see inbox-worker/). Used for accounts the agent creates for the
// user, so verification codes and confirmation links arrive where the agent can read them without asking anyone.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractLinks, extractMailCodes, htmlToText } from './mail-codes.ts';

export type InboxConfig = { url: string; token: string; address: string };
export type InboxMessage = { id: string; to: string; from: string; fromName: string | null; subject: string; text: string; html: string; receivedAt: number };
type Fetch = typeof fetch;

/** From INSTINCT_INBOX_URL/TOKEN/ADDRESS, or <home>/inbox.json written at setup. */
export function loadInboxConfig(home: string, env = process.env): InboxConfig | undefined {
  if (env.INSTINCT_INBOX_URL && env.INSTINCT_INBOX_TOKEN && env.INSTINCT_INBOX_ADDRESS) {
    return { url: env.INSTINCT_INBOX_URL, token: env.INSTINCT_INBOX_TOKEN, address: env.INSTINCT_INBOX_ADDRESS };
  }
  const file = join(home, 'inbox.json');
  if (!existsSync(file)) return undefined;
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return c.url && c.token && c.address ? { url: String(c.url), token: String(c.token), address: String(c.address).toLowerCase() } : undefined;
  } catch { return undefined; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const plain = (m: InboxMessage) => (m.text.trim() || (m.html ? htmlToText(m.html).body : '')).replace(/\n{3,}/g, '\n\n');
const when = (at: number) => {
  const mins = Math.round((Date.now() - at) / 60_000);
  return new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) + (mins < 1 ? ' (agora)' : ` (há ${mins} min)`);
};

export class AgentInbox {
  constructor(readonly config: InboxConfig | undefined, private fetcher: Fetch = fetch) {}

  get address() {
    if (!this.config) throw new Error('The agent has no mailbox configured (<home>/inbox.json). Use the user\u2019s profile email instead.');
    return this.config.address;
  }

  async list(sinceMs: number, limit = 20): Promise<InboxMessage[]> {
    const c = this.config;
    if (!c) throw new Error('The agent has no mailbox configured.');
    const url = new URL('/v1/messages', c.url);
    url.searchParams.set('since', String(sinceMs));
    url.searchParams.set('limit', String(limit));
    const res = await this.fetcher(url, { headers: { authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Mailbox unavailable (HTTP ${res.status}).`);
    return ((await res.json()) as { messages: InboxMessage[] }).messages;
  }

  /** Messages newest first, optionally waiting for one that matches. `match` looks at sender, name and subject. */
  async read(a: { since_minutes?: number; match?: string; wait_seconds?: number; id?: string; limit?: number }) {
    const since = Date.now() - Math.min(1440, Math.max(1, a.since_minutes ?? 30)) * 60_000;
    const deadline = Date.now() + Math.min(60, Math.max(0, a.wait_seconds ?? 0)) * 1000;
    const want = a.match ? fold(a.match).replace(/[^a-z0-9]/g, '') : '';
    const matches = (m: InboxMessage) => !want || fold(`${m.from} ${m.fromName ?? ''} ${m.subject}`).replace(/[^a-z0-9]/g, '').includes(want);
    for (;;) {
      const all = await this.list(a.id ? Date.now() - 30 * 86400_000 : since, a.id ? 50 : 20);
      if (a.id) {
        const m = all.find(x => x.id === a.id);
        if (!m) throw new Error('Unknown message id (messages older than 30 days are deleted).');
        return `From: ${m.fromName ? m.fromName + ' <' + m.from + '>' : m.from}\nTo: ${m.to}\nSubject: ${m.subject}\nReceived: ${when(m.receivedAt)}\n\n${plain(m).slice(0, 8000)}`;
      }
      const found = all.filter(matches).slice(0, Math.min(10, Math.max(1, a.limit ?? 5)));
      if (found.length || Date.now() >= deadline) {
        if (!found.length) return `No mail${want ? ' matching "' + a.match + '"' : ''} for ${this.address} in this window. Sites can take a minute; call again with wait_seconds if a message is expected.`;
        return found.map(m => {
          const text = plain(m);
          const codes = extractMailCodes(m.subject, m.text || m.html);
          const links = extractLinks(text, m.html);
          return [`id=${m.id} · ${when(m.receivedAt)} · from ${m.fromName ? m.fromName + ' <' + m.from + '>' : m.from} · to ${m.to}`,
            `Subject: ${m.subject}`,
            codes.length ? `Codes: ${codes.join(', ')}` : '',
            links.length ? `Links: ${links.join(' ')}` : '',
            `Text: ${text.replace(/\s+/g, ' ').slice(0, 300)}`].filter(Boolean).join('\n');
        }).join('\n\n');
      }
      await sleep(3000);
    }
  }
}

