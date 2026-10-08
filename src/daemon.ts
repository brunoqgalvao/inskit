// Long-lived local process that owns the agent browser, the vault and the purchase gate.
// Every Codex chat's MCP shim forwards tool calls here, so all chats share one browser and vault.
import './quiet.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { Db } from './db.ts';
import { Sealer } from './crypto.ts';
import { Vault } from './vault.ts';
import { Purchases } from './purchases.ts';
import { AgentBrowser } from './browser.ts';
import { Service } from './service.ts';
import { approvalPage, donePage, homePage, vaultPage, loginStatusPage } from './pages.ts';
import { BUILD_ID, VERSION } from './brand.ts';

const cfg = loadConfig();
mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
const db = new Db(join(cfg.home, 'instinct.db'));
const vault = new Vault(db, Sealer.fromHome(cfg.home));
const purchases = new Purchases(db);
const browser = new AgentBrowser(cfg);
const service = new Service(cfg, db, browser, vault, purchases);
const token = randomBytes(24).toString('base64url');

const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, new URL(cfg.publicUrl).host]);

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) {
  res.writeHead(status, {
    'content-type': type, 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit = 2_000_000) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const form = (body: string) => Object.fromEntries(new URLSearchParams(body));

/** Browser form posts must come from our own pages (blocks cross-site form posts to localhost). */
function sameOriginPost(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return req.headers['sec-fetch-site'] !== 'cross-site';
  try { return allowedHosts.has(new URL(origin).host); } catch { return false; }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;

    // API for the MCP shims (bearer token from daemon.json).
    if (path.startsWith('/api/')) {
      if (path === '/api/health') return send(res, 200, JSON.stringify({ ok: true, version: VERSION, build: BUILD_ID, pid: process.pid }), 'application/json');
      if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, '{"error":"unauthorized"}', 'application/json');
      if (path === '/api/call' && req.method === 'POST') {
        const { session, name, args, nativeApproval } = JSON.parse(await readBody(req));
        const result = await service.call(String(session || 'default'), String(name), args, { nativeApproval: !!nativeApproval });
        return send(res, 200, JSON.stringify(result), 'application/json');
      }
      if (path === '/api/shutdown' && req.method === 'POST') {
        send(res, 200, '{"ok":true}', 'application/json');
        await browser.close();
        process.exit(0);
      }
      return send(res, 404, '{"error":"not found"}', 'application/json');
    }

    // Human pages. Reject other Host headers (DNS rebinding).
    if (!allowedHosts.has(String(req.headers.host))) return send(res, 421, 'Wrong host', 'text/plain');
    if (req.method === 'POST' && !sameOriginPost(req)) return send(res, 403, 'Cross-site request refused', 'text/plain');

    const statusMatch = path.match(/^\/v\/([\w-]{20,})\/(status|retry|challenge)$/);
    if (statusMatch) {
      const original = vault.requestByToken(statusMatch[1]);
      if (!original || original.kind !== 'login' || Date.now() - original.createdAt > 30 * 60_000) return send(res, 404, '{}', 'application/json');
      if (statusMatch[2] === 'challenge' && req.method === 'POST') {
        try {
          const data = form(await readBody(req, 4096));
          vault.submitChallenge(original.token, data.challenge_id, data);
          service.startAutoFill(data.challenge_id);
          return send(res, 200, '{"ok":true}', 'application/json');
        } catch (error) {
          return send(res, 409, JSON.stringify({ error: error instanceof Error ? error.message : 'Não foi possível enviar.' }), 'application/json');
        }
      }
      if (statusMatch[2] === 'retry' && req.method === 'POST') {
        const next = vault.retryLogin(original.token);
        return send(res, 303, '', 'text/plain', { location: `/v/${next.token}` });
      }
      if (statusMatch[2] === 'status' && req.method === 'GET') {
        const current = vault.latestRequest(original.id)!;
        vault.markViewed(current);
        return send(res, 200, JSON.stringify({ login: current.login ?? { state: 'saved' }, challenge: vault.publicChallenge(current.challengeId), pending: current.status === 'pending', retry: !!original.retryId }), 'application/json');
      }
      return send(res, 405, '{}', 'application/json');
    }
    const vaultMatch = path.match(/^\/v\/([\w-]{20,})$/);
    if (vaultMatch) {
      const request = vault.requestByToken(vaultMatch[1]);
      const cardLabel = request?.itemId ? vault.item(request.itemId)?.label : undefined;
      if (req.method === 'POST') {
        try {
          vault.submit(vaultMatch[1], form(await readBody(req)));
          if (request?.kind === 'login') return send(res, 303, '', 'text/plain', { location: `/v/${request.token}` });
          return send(res, 200, donePage('Saved', 'Saved in the vault. You can close this tab; Codex continues on its own.'));
        } catch (error) {
          return send(res, 400, vaultPage(request, cardLabel, error instanceof Error ? error.message : String(error)));
        }
      }
      if (request?.kind === 'login' && request.status === 'done') {
        if (Date.now() - request.createdAt > 30 * 60_000) return send(res, 410, donePage('Link expired', 'Ask Codex for a new login status link.'));
        if (request.retryId) return send(res, 303, '', 'text/plain', { location: `/v/${vault.latestRequest(request.id)!.token}` });
        vault.markViewed(request);
        return send(res, 200, loginStatusPage(request, vault.publicChallenge(request.challengeId)));
      }
      return send(res, 200, vaultPage(request, cardLabel));
    }

    const approvalMatch = path.match(/^\/a\/([\w-]{20,})$/);
    if (approvalMatch) {
      const order = purchases.orderForToken(approvalMatch[1]);
      if (req.method === 'POST') {
        if (!order) return send(res, 404, approvalPage(undefined));
        const decision = form(await readBody(req)).decision;
        try {
          purchases.decide(order.id, decision === 'approve', `approval page: ${decision}`);
          return send(res, 200, decision === 'approve'
            ? donePage('Approved', 'Codex will now place this exact order. You can close this tab.')
            : donePage('Not buying', 'Got it. Codex will not place this order.'));
        } catch (error) {
          return send(res, 409, approvalPage(order, error instanceof Error ? error.message : String(error)));
        }
      }
      return send(res, 200, approvalPage(order));
    }

    if (path === '/' && req.method === 'GET') {
      const synced = (db.sql.prepare('select count(*) n from cookie_sync').get() as any).n;
      return send(res, 200, homePage(vault.list(), purchases.list(8), { browser: browser.running ? 'open' : 'idle', cookies: `${synced} sites imported` }));
    }
    const newMatch = path.match(/^\/new\/(card|identity)$/);
    if (newMatch && req.method === 'GET') {
      const request = vault.createRequest({ kind: newMatch[1] as 'card' | 'identity', purpose: newMatch[1] === 'card' ? 'Add a card' : 'Add an ID document' });
      return send(res, 303, '', 'text/plain', { location: `/v/${request.token}` });
    }
    const deleteMatch = path.match(/^\/items\/([\w-]+)\/delete$/);
    if (deleteMatch && req.method === 'POST') {
      vault.remove(deleteMatch[1]);
      return send(res, 303, '', 'text/plain', { location: '/' });
    }
    return send(res, 404, donePage('Not found', 'Nothing here.'));
  } catch (error) {
    send(res, 500, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), 'application/json');
  }
});

server.on('error', (error: any) => {
  if (error.code === 'EADDRINUSE') { console.error(`port ${cfg.port} busy; another daemon is running`); process.exit(3); }
  throw error;
});

server.listen(cfg.port, cfg.host, () => {
  const info = join(cfg.home, 'daemon.json');
  writeFileSync(info, JSON.stringify({ port: cfg.port, token, pid: process.pid, build: BUILD_ID }), { mode: 0o600 });
  chmodSync(info, 0o600);
  db.audit('daemon.start', { pid: process.pid, build: BUILD_ID });
  console.error(`instinct daemon ${VERSION} (${BUILD_ID}) on ${cfg.host}:${cfg.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await browser.close(); process.exit(0); });
