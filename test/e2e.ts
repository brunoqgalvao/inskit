// Drives the real daemon (real Chrome, headless) through a full purchase on the fixture store, without a model.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureStore } from './fixture-store.ts';

const home = mkdtempSync(join(tmpdir(), 'instinct-e2e-'));
Object.assign(process.env, {
  INSTINCT_HOME: home, INSTINCT_BROWSER_PROVIDER: 'local', INSTINCT_PORT: '17791', INSTINCT_OPEN_LINKS: '0', INSTINCT_COOKIE_SYNC: '0',
  INSTINCT_HEADLESS: process.env.HEADED ? '0' : '1', INSTINCT_DOWNLOADS: join(home, 'downloads'),
});
const { loadConfig } = await import('../src/config.ts');
const { DaemonClient } = await import('../src/client.ts');
const cfg = loadConfig();
const client = new DaemonClient(cfg);
const store = await startFixtureStore(17792);
const S = 'e2e-session';

const call = async (name: string, args: any = {}) => {
  const r = await client.call(S, name, args, { timeoutMs: 200_000 });
  const text = r.content.map((c: any) => c.text ?? '[image]').join('\n');
  return { ...r, text };
};
const step = (label: string) => console.log('✓ ' + label);
const refOf = (snap: string, re: RegExp) => {
  const line = snap.split('\n').find(l => re.test(l));
  const m = line?.match(/\[ref=(\w+)\]/);
  assert.ok(m, `no ref for ${re} in:\n${snap}`);
  return m![1];
};
const postForm = async (url: string, data: Record<string, string>) => {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(data), headers: { origin: cfg.publicUrl }, redirect: 'manual' });
  return { status: res.status, body: await res.text() };
};

try {
  let r = await call('browser_navigate', { url: store.url + '/checkout' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Checkout/);
  step('navigate + snapshot');

  r = await call('browser_click', { ref: refOf(r.text, /button "Place order"/), element: 'Place order' });
  assert.ok(r.isError && /purchase_propose/.test(r.text), r.text);
  step('direct click on "Place order" refused');

  r = await call('vault_request', { kind: 'card', purpose: 'Card for the fixture order' });
  const link = r.text.match(/(http:\/\/\S+\/v\/[\w-]+)/)?.[1];
  assert.ok(link, r.text);
  const requestId = r.text.match(/(req_\w+)/)![1];
  const cross = await fetch(link!, { method: 'POST', body: new URLSearchParams({ number: '4111111111111111' }), headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  const saved = await postForm(link!, { number: '4111 1111 1111 1111', expiry: '12/30', cvv: '123', holder: 'Ada Lovelace', rememberCvv: 'on' });
  assert.equal(saved.status, 200, saved.body);
  assert.equal((await postForm(link!, { number: '4111111111111111' })).status, 400, 'link must be single use');
  r = await call('vault_wait', { request_id: requestId, timeout_seconds: 5 });
  const cardId = r.text.match(/item_id="(v_\w+)"/)?.[1];
  assert.ok(cardId, r.text);
  r = await call('vault_list');
  assert.ok(!r.text.includes('4111111111111111') && r.text.includes('1111'), r.text);
  step('card saved via one-time vault page (cross-site post refused, link single use, list shows last 4 only)');

  let snap = (await call('browser_snapshot')).text;
  r = await call('vault_fill', { ref: refOf(snap, /textbox "Card number"/), item_id: cardId, field: 'number' });
  assert.ok(r.isError && /purchase_propose/.test(r.text), r.text);
  step('card fill refused before a proposal');

  r = await call('purchase_propose', {
    store_name: 'Fixture Store', store_url: store.url, currency: 'BRL',
    items: [{ name: 'Espresso Machine', quantity: 1, unit_price_cents: 49900 }],
    subtotal_cents: 49900, shipping_cents: 2900, total_cents: 52800,
    shipping_method: 'Standard', delivery_estimate: '3 days', address: 'Rua Teste 1, São Paulo', payment_method: 'Visa ending 1111',
  });
  assert.ok(!r.isError, r.text);
  const orderId = r.text.match(/(ord_\w+)/)![1];
  const approval = r.text.match(/(http:\/\/\S+\/a\/[\w-]+)/)?.[1];
  assert.ok(approval, r.text);
  r = await call('purchase_submit', { order_id: orderId, ref: refOf(snap, /button "Place order"/) });
  assert.ok(r.isError && /approved/.test(r.text), r.text);
  step('submit refused before approval');

  const page = await (await fetch(approval!)).text();
  assert.match(page, /R\$\s*528[,.]00|528\.00/);
  assert.equal((await postForm(approval!, { decision: 'approve' })).status, 200);
  r = await call('purchase_wait', { order_id: orderId, timeout_seconds: 5 });
  assert.match(r.text, /Approved/);
  step('approved on the approval page');

  snap = (await call('browser_snapshot')).text;
  for (const [label, field] of [[/textbox "Card number"/, 'number'], [/textbox "Expiry"/, 'expiry'], [/textbox "CVV"/, 'cvv'], [/textbox "Name on card"/, 'holder']] as const) {
    r = await call('vault_fill', { ref: refOf(snap, label), item_id: cardId, field });
    assert.ok(!r.isError, r.text);
  }
  snap = (await call('browser_snapshot')).text;
  assert.ok(!snap.includes('4111') && !/: 123\b/.test(snap), snap);
  r = await call('browser_read_text');
  assert.ok(!r.text.includes('4111'), r.text);
  r = await call('browser_screenshot');
  assert.ok(r.isError, 'screenshot must be blocked on a page with vault data');
  step('card filled from vault; never visible in snapshot, text or screenshot');

  r = await call('purchase_submit', { order_id: orderId, ref: refOf(snap, /button "Place order"/) });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /FX-20931/);
  r = await call('purchase_confirm', { order_id: orderId, store_order_number: 'FX-99999', paid_total_cents: 52800 });
  assert.ok(r.isError, 'order number not on page must be refused');
  r = await call('purchase_confirm', { order_id: orderId, store_order_number: 'FX-20931', paid_total_cents: 52800 });
  assert.ok(!r.isError, r.text);
  step('order placed and confirmed with the number on the page');

  snap = (await call('browser_snapshot')).text;
  await call('browser_click', { ref: refOf(snap, /link "Download invoice"/), element: 'invoice' });
  await new Promise(res => setTimeout(res, 1500));
  r = await call('browser_downloads');
  assert.match(r.text, /invoice-FX-20931\.pdf/);
  step('invoice download saved');

  r = await call('agent_status');
  console.log('\n' + r.text);
  console.log('\nE2E PASSED');
} finally {
  store.close();
  const info = await client.ensure().catch(() => undefined);
  if (info) await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } }).catch(() => {});
}

