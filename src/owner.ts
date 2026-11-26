// The owner API: what the owner's own app (mesa) calls to approve a purchase, store a secret and see the browser.
// Its token is its own file, owner.key, which no MCP shim reads: the agent holds the daemon token (daemon.json) and
// can propose and wait, never decide. Secrets come in here and go straight to the vault; nothing is logged.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { Order, Purchases } from './purchases.ts';
import type { RequestKind, Vault } from './vault.ts';
import type { AgentBrowser } from './browser.ts';
import { BUILD_ID, VERSION } from './brand.ts';

export const ownerKeyFile = (home: string) => join(home, 'owner.key');

/** The owner token, created on first start and kept (0600), so the owner's app reads it once. */
export function ownerToken(home: string): string {
  const file = ownerKeyFile(home);
  if (existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return saved;
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  writeFileSync(file, token + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

export type OwnerDeps = {
  token: string;
  cfg: Pick<Config, 'approval'>;
  vault: Vault;
  purchases: Purchases;
  browser: Pick<AgentBrowser, 'running' | 'mode' | 'liveUrl'>;
};
export type OwnerReply = { status: number; body: unknown };

const KINDS = new Set<RequestKind>(['card', 'login', 'identity', 'cvv']);

function same(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What the owner's app shows of an order. approvalEvidence stays in the daemon. */
export function publicOrder(o: Order) {
  return {
    id: o.id, status: o.status, storeName: o.storeName, storeHost: o.storeHost, storeUrl: o.storeUrl, currency: o.currency,
    totalCents: o.totalCents, quote: o.quote, createdAt: o.createdAt, approvedAt: o.approvedAt ?? null,
    storeOrderNumber: o.storeOrderNumber ?? null, failure: o.failure ?? null,
  };
}

export function ownerApi(deps: OwnerDeps) {
  const { vault, purchases } = deps;
  return async (method: string, path: string, authorization: string | undefined, body: () => Promise<string>): Promise<OwnerReply> => {
    if (!authorization?.startsWith('Bearer ') || !same(authorization.slice(7), deps.token)) return { status: 401, body: { error: 'unauthorized' } };
    const json = async () => {
      try { const v = JSON.parse(await body()); return v && typeof v === 'object' ? v as Record<string, any> : {}; } catch { return {}; }
    };

    if (path === '/owner/status' && method === 'GET') {
      const b = deps.browser;
      return { status: 200, body: { ok: true, version: VERSION, build: BUILD_ID, approval: deps.cfg.approval, browser: { running: b.running, mode: b.mode, liveUrl: b.liveUrl ?? null } } };
    }

    const order = path.match(/^\/owner\/orders\/(ord_\w+)(\/decide)?$/);
    if (order) {
      const found = purchases.get(order[1]);
      if (!found) return { status: 404, body: { error: 'Order not found' } };
      if (!order[2] && method === 'GET') return { status: 200, body: { order: publicOrder(found) } };
      if (order[2] && method === 'POST') {
        const input = await json();
        if (typeof input.approve !== 'boolean') return { status: 400, body: { error: 'approve must be true or false' } };
        if (found.status !== 'awaiting_approval') return { status: 409, body: { error: `Order is ${found.status}, not awaiting approval.`, order: publicOrder(found) } };
        const via = typeof input.via === 'string' && input.via.trim() ? input.via.trim().slice(0, 80) : 'owner app';
        const decided = purchases.decide(found.id, input.approve, `${via}: ${input.approve ? 'approve' : 'reject'}`, 'owner');
        return { status: 200, body: { order: publicOrder(decided) } };
      }
      return { status: 405, body: { error: 'method not allowed' } };
    }

    if (path === '/owner/vault' && method === 'GET') return { status: 200, body: { items: vault.list() } };

    const request = path.match(/^\/owner\/vault\/requests\/(req_\w+)$/);
    if (request && method === 'GET') {
      const r = vault.requestById(request[1]);
      if (!r) return { status: 404, body: { error: 'Request not found' } };
      return { status: 200, body: { request: { id: r.id, kind: r.kind, purpose: r.purpose, origin: r.origin ?? null, status: r.status, cardLabel: r.itemId ? vault.item(r.itemId)?.label ?? null : null } } };
    }

    if (path === '/owner/vault' && method === 'POST') {
      const input = await json();
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(input.fields && typeof input.fields === 'object' ? input.fields : {})) {
        if (typeof v === 'string') fields[k] = v; else if (typeof v === 'boolean') fields[k] = v ? 'true' : '';
      }
      try {
        const pending = typeof input.request_id === 'string' ? vault.requestById(input.request_id) : undefined;
        if (typeof input.request_id === 'string' && !pending) return { status: 404, body: { error: 'Request not found' } };
        if (!pending && !KINDS.has(input.kind)) return { status: 400, body: { error: 'kind must be card, login, identity or cvv' } };
        const target = pending ?? vault.createRequest({ kind: input.kind, purpose: String(input.purpose ?? 'Added in the owner app'), origin: typeof input.origin === 'string' ? input.origin : undefined, itemId: typeof input.item_id === 'string' ? input.item_id : undefined });
        const { itemId } = vault.submit(target.token, fields);
        return { status: 200, body: { item: vault.item(itemId) ?? null, request_id: target.id } };
      } catch (error) {
        // Vault errors name the field that is wrong, never its value.
        return { status: 400, body: { error: error instanceof Error ? error.message : 'Could not save.' } };
      }
    }
    return { status: 404, body: { error: 'not found' } };
  };
}
