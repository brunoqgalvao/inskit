import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.ts';
import { Sealer } from '../src/crypto.ts';
import { Vault } from '../src/vault.ts';
import { Service } from '../src/service.ts';
import { Purchases } from '../src/purchases.ts';
import { loadConfig } from '../src/config.ts';
import type { AgentBrowser } from '../src/browser.ts';

const proposal = {
  store_name: 'Fixture Store', store_url: 'https://shop.example.com/checkout', currency: 'BRL',
  items: [{ name: 'Coffee capsules', quantity: 2, unit_price_cents: 4930 }],
  subtotal_cents: 9860, shipping_cents: 0, total_cents: 9860,
  shipping_method: 'Free', delivery_estimate: 'Monday', address: 'Rua Teste 1', payment_method: 'Mastercard ending 1558',
};

function fixture(approval: 'chat' | 'page' = 'chat', present = (_ref: string) => true) {
  const db = new Db(':memory:');
  const clicks: string[] = [];
  const browser = {
    currentUrl: async () => 'https://shop.example.com/checkout',
    rawText: async () => 'Total R$ 98,60 Pagar e finalizar',
    purchaseTarget: async (_s: string, ref: string) => { if (!present(ref)) throw new Error('Invalid frame in aria-ref selector'); },
    clickPurchase: async (_s: string, ref: string) => { clicks.push(ref); return 'Order #123'; },
  } as unknown as AgentBrowser;
  const purchases = new Purchases(db);
  const service = new Service({ ...loadConfig(), openLinks: false, approval }, db, browser, new Vault(db, Sealer.forTests()), purchases);
  const call = async (name: string, args: any) => {
    const r = await service.call('test', name, args);
    return { ...r, text: r.content.map((c: any) => c.text).join('\n') };
  };
  return { db, purchases, call, clicks };
}

test('chat approval: no page opens, the gate holds until the user answers, and their words are recorded', async () => {
  const { db, purchases, call, clicks } = fixture();
  try {
    const proposed = await call('purchase_propose', proposal);
    assert.ok(!proposed.isError, proposed.text);
    const orderId = proposed.text.match(/ord_\w+/)![0];
    assert.match(proposed.text, /purchase_approve/);
    assert.doesNotMatch(proposed.text, /just opened/);

    const early = await call('purchase_submit', { order_id: orderId, ref: 'e1' });
    assert.ok(early.isError && /approved/.test(early.text), early.text);
    assert.equal(clicks.length, 0);

    const blank = await call('purchase_approve', { order_id: orderId, approve: true, user_reply: '   ' });
    assert.ok(blank.isError, blank.text);

    const ok = await call('purchase_approve', { order_id: orderId, approve: true, user_reply: 'sim, pode comprar' });
    assert.ok(!ok.isError, ok.text);
    assert.match(ok.text, /98[,.]60/);
    assert.equal(purchases.get(orderId)?.status, 'approved');
    assert.equal(purchases.get(orderId)?.approvalEvidence, 'chat: "sim, pode comprar"');

    const again = await call('purchase_approve', { order_id: orderId, approve: true, user_reply: 'sim' });
    assert.ok(again.isError, 'an order is approved once');

    const submitted = await call('purchase_submit', { order_id: orderId, ref: 'e1' });
    assert.ok(!submitted.isError, submitted.text);
    assert.deepEqual(clicks, ['e1']);
  } finally { db.sql.close(); }
});

test('a declined chat answer blocks payment; page mode keeps the approval page flow', async () => {
  const chat = fixture();
  try {
    const orderId = (await chat.call('purchase_propose', proposal)).text.match(/ord_\w+/)![0];
    const no = await chat.call('purchase_approve', { order_id: orderId, approve: false, user_reply: 'não, espera' });
    assert.match(no.text, /declined/);
    assert.equal(chat.purchases.get(orderId)?.status, 'rejected');
    assert.ok((await chat.call('purchase_submit', { order_id: orderId, ref: 'e1' })).isError);
    assert.equal(chat.clicks.length, 0);
  } finally { chat.db.sql.close(); }

  const page = fixture('page');
  try {
    const proposed = await page.call('purchase_propose', proposal);
    assert.match(proposed.text, /purchase_wait/);
    assert.match(proposed.text, /\/a\/[\w-]{20,}/);
  } finally { page.db.sql.close(); }
});

test('a stale button ref clicks nothing and leaves the order approved for a retry', async () => {
  const { db, purchases, call, clicks } = fixture('chat', ref => ref !== 'f11e190');
  try {
    const orderId = (await call('purchase_propose', proposal)).text.match(/ord_\w+/)![0];
    await call('purchase_approve', { order_id: orderId, approve: true, user_reply: 'pode' });
    const stale = await call('purchase_submit', { order_id: orderId, ref: 'f11e190' });
    assert.ok(stale.isError && /Nothing was clicked/.test(stale.text), stale.text);
    assert.equal(purchases.get(orderId)?.status, 'approved');
    assert.equal(clicks.length, 0);
    const fresh = await call('purchase_submit', { order_id: orderId, ref: 'f3e190' });
    assert.ok(!fresh.isError, fresh.text);
    assert.deepEqual(clicks, ['f3e190']);
    assert.equal(purchases.get(orderId)?.status, 'submitted');
  } finally { db.sql.close(); }
});

test('switching a checkout to the card form is not a payment; paying buttons still are', async () => {
  const { isPurchaseButton } = await import('../src/browser.ts');
  for (const label of ['Pagar sem o Link', 'Pay without Link', 'pagar  sem  Link']) assert.equal(isPurchaseButton(label), false, label);
  for (const label of ['Pagar', 'Pagar com Link', 'Pay now', 'Finalizar compra', 'Pay $10.00', 'Compre agora', 'Comprar agora com 1-Clique', 'Compre já']) assert.equal(isPurchaseButton(label), true, label);
});

