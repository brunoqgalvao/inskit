// Delegation benchmark: node --no-warnings --import tsx bench/delegate.ts [luna|haiku]
import { mkdtempSync, rmSync } from 'node:fs';
import { Db } from '../src/db.ts';
import { Sealer } from '../src/crypto.ts';
import { Vault } from '../src/vault.ts';
import { Service } from '../src/service.ts';
import { Purchases } from '../src/purchases.ts';
import { loadConfig } from '../src/config.ts';
import { AgentBrowser } from '../src/browser.ts';

const model = process.argv[2] || 'luna';
const tasks = [
  { id: 'saucedemo-price', start: 'https://www.saucedemo.com/', login: { origin: 'https://www.saucedemo.com', username: 'standard_user', password: 'secret_sauce' },
    task: 'Log in with the saved login, then report the price of "Sauce Labs Backpack".', expect: '29.99' },
  { id: 'table-lookup', start: 'https://the-internet.herokuapp.com/tables',
    task: 'In the first table, report the email of the person whose last name is Doe.', expect: 'jdoe@hotmail.com' },
  { id: 'paginate', start: 'https://quotes.toscrape.com/',
    task: 'Go to the second page of quotes and report the author of the first quote there.', expect: 'Marilyn Monroe' },
  { id: 'form', start: 'https://practice.expandtesting.com/inputs',
    task: 'Type 42 in the Number input and "inskit" in the Text input, click Display Inputs, and report the displayed text output.', expect: 'inskit' },
];

let ok = 0, totalMs = 0, cost = 0, calls = 0;
for (const t of tasks.filter(t => !process.argv[3] || process.argv[3].split(',').includes(t.id))) {
  const home = mkdtempSync('/tmp/inskit-delegate-');
  const browser = new AgentBrowser({ ...loadConfig(), home, browserUse: undefined, cdpUrl: undefined, headless: true, cookieSync: false });
  const db = new Db(':memory:'), vault = new Vault(db, Sealer.forTests());
  const service = new Service({ ...loadConfig(), home, openLinks: false, cookieSync: false }, db, browser, vault, new Purchases(db));
  try {
    if (t.login) { const r = vault.createRequest({ kind: 'login', origin: t.login.origin, purpose: 'bench' }); vault.submit(r.token, { username: t.login.username, password: t.login.password }); }
    await service.call('d', 'browser_navigate', { url: t.start });
    const r = await service.call('d', 'browser_delegate', { task: t.task, model, budget_seconds: 120 });
    const d: any = r.structuredContent ?? {};
    const pass = !!d.success && String(d.result).includes(t.expect);
    ok += pass ? 1 : 0; totalMs += d.ms ?? 0; cost += d.model?.cost_usd ?? 0; calls += d.model?.calls ?? 0;
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + t.id.padEnd(16) + ' ' + ((d.ms ?? 0) / 1000).toFixed(1) + 's  ' + (d.model?.calls ?? 0) + ' calls  $' + (d.model?.cost_usd ?? 0).toFixed(4) + '  ' + String(d.result ?? r.content[0]).slice(0, 120).replace(/\n/g, ' ') + (pass ? '' : '\n      steps: ' + (d.steps ?? []).join(' > ').slice(0, 600)));
  } finally { await browser.close().catch(() => {}); db.sql.close(); rmSync(home, { recursive: true, force: true }); }
}
console.log(model + ': ' + ok + '/' + tasks.length + ' correct, ' + (totalMs / 1000 / tasks.length).toFixed(1) + 's average, ' + calls + ' model calls, $' + cost.toFixed(4) + ' total');
process.exit(0);

