// Screenshots of the human-facing pages (vault, approval, home) for docs and review.
import { chromium } from 'playwright-core';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? '/tmp/instinct-shots';
mkdirSync(out, { recursive: true });
Object.assign(process.env, { INSTINCT_HOME: mkdtempSync(join(tmpdir(), 'instinct-shots-')), INSTINCT_PORT: '17799', INSTINCT_OPEN_LINKS: '0', INSTINCT_HEADLESS: '1', INSTINCT_BROWSER_PROVIDER: 'local' });
const { loadConfig } = await import('../src/config.ts');
const { DaemonClient } = await import('../src/client.ts');
const cfg = loadConfig();
const client = new DaemonClient(cfg);
const text = (r: any) => r.content.map((c: any) => c.text ?? '').join('\n');
const link = (t: string) => t.match(/(http:\/\/\S+\/[va]\/[\w-]+)/)![1];

const card = link(text(await client.call('s', 'vault_request', { kind: 'card', purpose: 'Card for the Nespresso order' })));
const proposal = link(text(await client.call('s', 'purchase_propose', {
  store_name: 'Nespresso', store_url: 'https://www.nespresso.com/br', currency: 'BRL',
  items: [{ name: 'Vertuo Double Espresso Scuro (10 caps)', quantity: 3, unit_price_cents: 4290 }, { name: 'Descaling kit', quantity: 1, unit_price_cents: 6900 }],
  subtotal_cents: 19770, shipping_cents: 0, discount_cents: 1977, total_cents: 17793,
  shipping_method: 'Standard (free)', delivery_estimate: 'Fri, Oct 3', address: 'Rua Exemplo 123, ap 45 · São Paulo, SP 04500-000', payment_method: 'Visa ending 4242',
  notes: '10% off for Club members applied',
})));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const [name, url, scheme] of [['vault-card', card, 'light'], ['approval', proposal, 'light'], ['approval-dark', proposal, 'dark'], ['home', cfg.publicUrl + '/', 'light']] as const) {
  const page = await browser.newPage({ viewport: { width: 760, height: 860 }, deviceScaleFactor: 2, colorScheme: scheme });
  await page.goto(url);
  await page.screenshot({ path: join(out, name + '.png'), fullPage: true });
  await page.close();
}
await browser.close();
const info = await client.ensure();
await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } }).catch(() => {});
console.log('shots in ' + out);

