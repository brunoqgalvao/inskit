import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.ts';
import { Sealer } from '../src/crypto.ts';
import { Vault } from '../src/vault.ts';
import { Service, type CallOpts } from '../src/service.ts';
import { Purchases } from '../src/purchases.ts';
import { loadConfig } from '../src/config.ts';
import { ownerApi, ownerToken } from '../src/owner.ts';
import type { AgentBrowser } from '../src/browser.ts';

const proposal = {
  store_name: 'Fixture Store', store_url: 'https://shop.example.com/checkout', currency: 'BRL',
  items: [{ name: 'Coffee capsules', quantity: 2, unit_price_cents: 4930 }],
  subtotal_cents: 9860, shipping_cents: 0, total_cents: 9860,
  shipping_method: 'Free', delivery_estimate: 'Monday', address: 'Rua Teste 1', payment_method: 'Mastercard ending 1558',
};
const TOKEN = 'owner-token-for-tests-0123456789abcdef';
const CARD = { number: '4111 1111 1111 1111', expiry: '12/30', holder: 'Test Person', cvv: '123', label: 'Visa de teste' };

function fixture(approval: 'chat' | 'owner' = 'chat') {
  const db = new Db(':memory:');
  const clicks: string[] = [];
  const browser = {
    running: true, mode: 'Browser Use Cloud', liveUrl: 'https://live.example.com/s/1',
    currentUrl: async () => 'https://shop.example.com/checkout',
    rawText: async () => 'Total R$ 98,60 Pagar e finalizar',
    purchaseTarget: async () => {},
    clickPurchase: async (_s: string, ref: string) => { clicks.push(ref); return 'Order #123'; },
    show: async () => 'https://shop.example.com/checkout',
    navigate: async (_s: string, url: string) => `opened ${url}`,
  } as unknown as AgentBrowser;
  const purchases = new Purchases(db);
  const vault = new Vault(db, Sealer.forTests());
  const cfg = { ...loadConfig(), openLinks: false, approval, port: 17999, publicUrl: 'http://127.0.0.1:17999', browserUse: { proxyCountry: 'br', timeoutMinutes: 5, apiKey: 'x' } };
  const service = new Service(cfg, db, browser, vault, purchases);
  const call = async (name: string, args: any, opts: CallOpts = {}) => {
    const r = await service.call('test', name, args, opts);
    return { ...r, text: r.content.map((c: any) => c.text).join('\n') };
  };
  const api = ownerApi({ token: TOKEN, cfg, vault, purchases, browser });
  const owner = (method: string, path: string, body?: unknown, token = TOKEN) => api(method, path, `Bearer ${token}`, async () => JSON.stringify(body ?? {}));
  return { db, purchases, vault, call, owner, clicks };
}

test('owner mode: the agent cannot approve its own order; the owner API approves it once and the gate opens', async () => {
  const { db, purchases, call, owner, clicks } = fixture();
  try {
    const proposed = await call('purchase_propose', proposal, { ownerApp: true });
    assert.ok(!proposed.isError, proposed.text);
    const id = proposed.text.match(/ord_\w+/)![0];
    assert.match(proposed.text, /purchase_wait/);
    assert.doesNotMatch(proposed.text, /\/a\/|purchase_approve/, 'no approval link and no chat approval for the agent');
    assert.equal(purchases.get(id)?.approvalMode, 'owner');

    // Every way the agent has to say yes is refused, from an owner-app chat and from a plain one alike.
    for (const opts of [{ ownerApp: true }, {}]) {
      const self = await call('purchase_approve', { order_id: id, approve: true, user_reply: 'sim, pode comprar' }, opts);
      assert.ok(self.isError && /Only the owner/.test(self.text), self.text);
      assert.ok((await call('__decide', { order_id: id, approve: true }, opts)).isError);
    }
    assert.ok((await call('purchase_submit', { order_id: id, ref: 'e1' })).isError);
    assert.equal(purchases.get(id)?.status, 'awaiting_approval');
    assert.equal(clicks.length, 0);

    assert.equal((await owner('GET', `/owner/orders/${id}`, undefined, 'wrong-token')).status, 401);
    assert.equal((await owner('POST', `/owner/orders/${id}/decide`, { approve: true }, 'wrong-token')).status, 401);
    assert.equal((await owner('POST', `/owner/orders/${id}/decide`, { approve: 'yes' })).status, 400);

    const seen = await owner('GET', `/owner/orders/${id}`);
    assert.equal(seen.status, 200);
    const shown = (seen.body as any).order;
    assert.equal(shown.totalCents, 9860);
    assert.equal(shown.quote.paymentMethod, 'Mastercard ending 1558');
    assert.equal(shown.approvalEvidence, undefined);

    const yes = await owner('POST', `/owner/orders/${id}/decide`, { approve: true, via: 'mesa' });
    assert.equal(yes.status, 200);
    assert.equal(purchases.get(id)?.status, 'approved');
    assert.equal(purchases.get(id)?.approvalEvidence, 'mesa: approve');

    const twice = await owner('POST', `/owner/orders/${id}/decide`, { approve: true });
    assert.equal(twice.status, 409, 'an order is decided once');
    assert.equal((twice.body as any).order.status, 'approved');

    assert.match((await call('purchase_wait', { order_id: id, timeout_seconds: 5 })).text, /Approved/);
    assert.ok(!(await call('purchase_submit', { order_id: id, ref: 'e1' })).isError);
    assert.deepEqual(clicks, ['e1']);
    assert.equal((await owner('GET', '/owner/orders/ord_missing')).status, 404);
  } finally { db.sql.close(); }
});

test('owner mode for the whole daemon; a rejection blocks payment; chat orders keep chat approval', async () => {
  const whole = fixture('owner');
  try {
    const id = (await whole.call('purchase_propose', proposal)).text.match(/ord_\w+/)![0];
    assert.equal(whole.purchases.get(id)?.approvalMode, 'owner');
    assert.ok((await whole.call('purchase_approve', { order_id: id, approve: true, user_reply: 'sim' })).isError);
    assert.equal((await whole.owner('POST', `/owner/orders/${id}/decide`, { approve: false })).status, 200);
    assert.equal(whole.purchases.get(id)?.status, 'rejected');
    assert.match((await whole.call('purchase_wait', { order_id: id, timeout_seconds: 5 })).text, /declined/);
    assert.ok((await whole.call('purchase_submit', { order_id: id, ref: 'e1' })).isError);
    assert.equal(whole.clicks.length, 0);
  } finally { whole.db.sql.close(); }

  const chat = fixture();
  try {
    const id = (await chat.call('purchase_propose', proposal)).text.match(/ord_\w+/)![0];
    assert.equal(chat.purchases.get(id)?.approvalMode, undefined);
    assert.ok(!(await chat.call('purchase_approve', { order_id: id, approve: true, user_reply: 'sim' })).isError);
  } finally { chat.db.sql.close(); }
});

test('owner API stores a secret for the agent\'s request; the agent sees the label, never the value', async () => {
  const { db, vault, call, owner } = fixture();
  try {
    const asked = await call('vault_request', { kind: 'card', purpose: 'Card for the coffee order' }, { ownerApp: true });
    assert.ok(!asked.isError, asked.text);
    const requestId = asked.text.match(/req_\w+/)![0];
    assert.doesNotMatch(asked.text, /\/v\//, 'no local page for an owner-app chat');

    const pending = await owner('GET', `/owner/vault/requests/${requestId}`);
    assert.deepEqual((pending.body as any).request, { id: requestId, kind: 'card', purpose: 'Card for the coffee order', origin: null, status: 'pending', cardLabel: null });

    const bad = await owner('POST', '/owner/vault', { request_id: requestId, fields: { ...CARD, number: '4111 1111 1111 1112' } });
    assert.equal(bad.status, 400);
    assert.doesNotMatch(JSON.stringify(bad.body), /4111/, 'an error never repeats what was typed');
    assert.equal((await owner('POST', '/owner/vault', { request_id: requestId, fields: CARD }, 'wrong-token')).status, 401);

    const saved = await owner('POST', '/owner/vault', { request_id: requestId, fields: CARD });
    assert.equal(saved.status, 200);
    const item = (saved.body as any).item;
    assert.equal(item.label, 'Visa de teste');
    assert.equal(item.details.last4, '1111');
    assert.doesNotMatch(JSON.stringify(saved.body), /4111 ?1111 ?1111|"123"/);
    assert.equal((await owner('POST', '/owner/vault', { request_id: requestId, fields: CARD })).status, 400, 'a request is used once');

    const waited = await call('vault_wait', { request_id: requestId, timeout_seconds: 5 });
    assert.match(waited.text, new RegExp(item.id));
    const listed = await call('vault_list', {});
    assert.doesNotMatch(listed.text + waited.text, /4111111111111111|4111 1111 1111 1111/);

    // Without a request: the owner adds a login from their app.
    const login = await owner('POST', '/owner/vault', { kind: 'login', origin: 'https://shop.example.com/login', fields: { username: 'me@example.com', password: 'hunter2-secret' } });
    assert.equal(login.status, 200);
    assert.doesNotMatch(JSON.stringify(login.body), /hunter2/);
    assert.equal(((await owner('GET', '/owner/vault')).body as any).items.length, 2);
    assert.equal(vault.list().length, 2);
    assert.doesNotMatch(JSON.stringify(db.sql.prepare('select data from audit').all()), /hunter2|4111111111111111/, 'the audit log holds no secret');
  } finally { db.sql.close(); }
});

test('owner-app handover names no link; status carries the live preview; the agent browser refuses the daemon\'s own pages', async () => {
  const { db, call, owner } = fixture();
  try {
    const hand = await call('browser_hand_over', { reason: 'Solve the CAPTCHA' }, { ownerApp: true });
    assert.match(hand.text, /browser_handoff/);
    assert.doesNotMatch(hand.text, /live\.example\.com/);
    const plain = await call('browser_hand_over', { reason: 'Solve the CAPTCHA' });
    assert.match(plain.text, /live\.example\.com/, 'a plain chat still gets the link');

    const status = await owner('GET', '/owner/status');
    assert.equal((status.body as any).browser.liveUrl, 'https://live.example.com/s/1');
    assert.equal((await owner('GET', '/owner/status', undefined, 'nope')).status, 401);

    for (const url of ['http://127.0.0.1:17999/', 'localhost:17999/a/abc', 'http://127.0.0.1:17999/new/card']) {
      const r = await call('browser_navigate', { url });
      assert.ok(r.isError && /private page/.test(r.text), `${url}: ${r.text}`);
    }
    assert.ok(!(await call('browser_navigate', { url: 'https://shop.example.com' })).isError);
  } finally { db.sql.close(); }
});

test('the owner token is its own file, 0600, and stays the same across starts', () => {
  const home = mkdtempSync(join(tmpdir(), 'inskit-owner-'));
  try {
    const first = ownerToken(home);
    assert.ok(first.length >= 32);
    assert.equal(ownerToken(home), first);
    assert.equal(readFileSync(join(home, 'owner.key'), 'utf8').trim(), first);
    assert.equal(statSync(join(home, 'owner.key')).mode & 0o777, 0o600);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
