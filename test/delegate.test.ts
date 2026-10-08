import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { Db } from '../src/db.ts';
import { Sealer } from '../src/crypto.ts';
import { Vault } from '../src/vault.ts';
import { Service } from '../src/service.ts';
import { Purchases } from '../src/purchases.ts';
import { loadConfig } from '../src/config.ts';
import { AgentBrowser } from '../src/browser.ts';

const shell = (b: string) => '<!doctype html><meta charset=utf-8><body>' + b + '</body>';
const pages: Record<string, string> = {
  '/': shell('<a href=/orders>Meus pedidos</a><input aria-label="Cupom"><button onclick="location=\'/paid\'">Finalizar compra</button>'),
  '/orders': shell('<h1>Pedidos</h1><p>Pedido 123: Entregue em 2 de outubro</p>'),
  '/paid': shell('<h1>Pago</h1>'),
};

test('delegated task: the inner model drives, purchase clicks and card numbers are refused, the result comes back', async () => {
  // Scripted inner model: tries the forbidden actions first, then does the task.
  const script = [
    (p: string) => ({ action: 'click', ref: ref(p, 'button "Finalizar compra"') }),
    (p: string) => ({ action: 'type', ref: ref(p, 'textbox "Cupom"'), text: '4111 1111 1111 1111' }),
    (p: string) => ({ action: 'click', ref: ref(p, 'link "Meus pedidos"') }),
    () => ({ action: 'done', success: true, result: 'Pedido 123: Entregue em 2 de outubro' }),
  ];
  const ref = (p: string, name: string) => p.split('\n').find(l => l.includes(name))?.match(/\[ref=([^\]]+)\]/)?.[1];
  let turn = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const prompt: string = JSON.parse(body).input[0].content[0].text;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output_text: JSON.stringify(script[Math.min(turn++, script.length - 1)](prompt)), usage: { input_tokens: 300, output_tokens: 20 } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  process.env.INSKIT_LUNA_BASE_URL = 'http://127.0.0.1:' + (server.address() as any).port + '/v1';
  const home = mkdtempSync('/tmp/inskit-delegate-test-');
  const browser = new AgentBrowser({ ...loadConfig(), home, browserUse: undefined, cdpUrl: undefined, headless: true, cookieSync: false });
  const db = new Db(':memory:');
  const service = new Service({ ...loadConfig(), home, openLinks: false, cookieSync: false }, db, browser, new Vault(db, Sealer.forTests()), new Purchases(db));
  try {
    const page = await browser.page('s');
    await page.route('https://shop.example.com/**', route => route.fulfill({ contentType: 'text/html', body: pages[new URL(route.request().url()).pathname] ?? shell('?') }));
    await service.call('s', 'browser_navigate', { url: 'https://shop.example.com/' });
    const r = await service.call('s', 'browser_delegate', { task: 'Report the status of order 123.' });
    const d: any = r.structuredContent;
    assert.equal(d.success, true);
    assert.match(d.result, /Entregue/);
    assert.match(d.steps[0], /^failed click/);
    assert.match(d.steps[1], /^failed type/);
    assert.notEqual(new URL(page.url()).pathname, '/paid');
    assert.equal(new URL(page.url()).pathname, '/orders');
  } finally {
    await browser.close(); db.sql.close(); rmSync(home, { recursive: true, force: true }); server.close(); delete process.env.INSKIT_LUNA_BASE_URL;
  }
});

