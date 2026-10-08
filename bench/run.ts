// Login benchmark: node --no-warnings --import tsx bench/run.ts --tier A|B|all --env local|cloud --fallback off|luna|haiku [--only id,id] [--repeat N]
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Db } from '../src/db.ts';
import { Sealer } from '../src/crypto.ts';
import { Vault } from '../src/vault.ts';
import { Service } from '../src/service.ts';
import { Purchases } from '../src/purchases.ts';
import { loadConfig } from '../src/config.ts';
import { AgentBrowser } from '../src/browser.ts';
import { CASES, type Case } from './sites.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const tier = arg('tier', 'A'), env = arg('env', 'local'), fallback = arg('fallback', 'off'), repeat = Number(arg('repeat', '1'));
const only = arg('only', '').split(',').filter(Boolean);
// Browser Use Cloud list prices (browser-use.com/pricing, Oct 2026): $0.02 per browser-hour, managed residential proxy $5/GB.
const CLOUD_USD_PER_HOUR = Number(process.env.BENCH_CLOUD_USD_PER_HOUR || '0.02');
const PROXY_USD_PER_GB = Number(process.env.BENCH_PROXY_USD_PER_GB || '5');
const cases = CASES.filter(c => !c.manual && (tier === 'all' || c.tier === tier) && (!only.length || only.includes(c.id)));
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + tier + '-' + env + '-' + fallback;
const out = join(import.meta.dirname, 'results', runId);
mkdirSync(out, { recursive: true });

type Row = { id: string; tier: string; expect: string; outcome: string; pass: boolean; driver: string; drivers_tried: string; login_ms: number; wall_ms: number;
  steps: string; success_text?: boolean; model_calls: number; tokens: number; model_usd: number; browser_s: number; mb: number; error?: string };

function newBrowser(home: string) {
  if (env === 'cloud') {
    const key = readFileSync(join(homedir(), '.instinct', 'browser-use.key'), 'utf8').trim();
    process.env.BROWSER_USE_API_KEY = key;
    return new AgentBrowser({ ...loadConfig(), home, cdpUrl: undefined, cookieSync: false, browserUse: { apiKey: key, proxyCountry: 'br', timeoutMinutes: 15 } });
  }
  return new AgentBrowser({ ...loadConfig(), home, browserUse: undefined, cdpUrl: undefined, headless: true, cookieSync: false });
}

const understood = ['rejected', 'code_requested', 'method_choice', 'needs_human', 'blocked'];

async function runCase(c: Case): Promise<Row> {
  // A fresh browser per case: no cookies leak between a correct and a wrong-password run.
  const home = mkdtempSync('/tmp/inskit-bench-');
  const browser = newBrowser(home);
  const db = new Db(':memory:'), vault = new Vault(db, Sealer.forTests());
  const service = new Service({ ...loadConfig(), home, openLinks: false, cookieSync: false }, db, browser, vault, new Purchases(db));
  const session = 'bench-' + c.id;
  const started = Date.now();
  const row: Row = { id: c.id, tier: c.tier, expect: c.expect, outcome: 'error', pass: false, driver: '', drivers_tried: '', login_ms: 0, wall_ms: 0, steps: '', model_calls: 0, tokens: 0, model_usd: 0, browser_s: 0, mb: 0 };
  try {
    const username = c.username ?? 'inskit-bench-' + randomBytes(4).toString('hex') + '@example.com';
    const password = c.password ?? 'Bench-' + randomBytes(8).toString('hex') + '!';
    const req = vault.createRequest({ kind: 'login', origin: new URL(c.url).origin, purpose: 'bench' });
    const { itemId } = vault.submit(req.token, { username, password });
    // Bytes on the wire: with the managed proxy this is the dominant cloud cost.
    let bytes = 0;
    const page = await browser.page(session);
    page.on('requestfinished', req => { req.sizes().then(z => { bytes += z.responseBodySize + z.responseHeadersSize + z.requestBodySize + z.requestHeadersSize; }).catch(() => {}); });
    const r = await service.call(session, 'vault_login_attempt', { item_id: itemId, url: c.url, model_fallback: fallback });
    const textOut = r.content.map((x: any) => x.text ?? '').join('\n');
    const d: any = r.structuredContent ?? {};
    if (r.isError) { row.error = textOut.slice(0, 200); }
    Object.assign(row, { outcome: d.outcome ?? 'error', driver: d.driver ?? '', drivers_tried: (d.drivers_tried ?? []).join(','), login_ms: d.ms ?? 0, steps: (d.steps ?? []).join(' > '),
      model_calls: d.model?.calls ?? 0, tokens: (d.model?.input_tokens ?? 0) + (d.model?.output_tokens ?? 0), model_usd: d.model?.cost_usd ?? 0 });
    if (c.successText) {
      if (row.outcome === 'logged_in') await service.call(session, 'browser_wait', { seconds: 8, text: c.successText });
      const page = (await service.call(session, 'browser_read_text', { max_chars: 20000 })).content.map((x: any) => x.text ?? '').join('');
      row.success_text = page.includes(c.successText);
    }
    await new Promise(r => setTimeout(r, 300));
    row.mb = Math.round(bytes / 1e4) / 100;
    row.pass = c.expect === 'understood' ? understood.includes(row.outcome)
      : c.expect === 'logged_in' ? row.outcome === 'logged_in' && row.success_text !== false
      : row.outcome === c.expect;
    writeFileSync(join(out, (row.pass ? 'pass-' : 'FAIL-') + c.id + '.txt'), textOut.slice(0, 9000));
  } catch (error) {
    row.error = error instanceof Error ? error.message.split('\n')[0].slice(0, 200) : String(error);
  } finally {
    row.wall_ms = Date.now() - started;
    row.browser_s = Math.round(row.wall_ms / 1000);
    await browser.close().catch(() => {});
    db.sql.close(); rmSync(home, { recursive: true, force: true });
  }
  return row;
}

const pct = (n: number, d: number) => d ? Math.round(100 * n / d) + '%' : '-';
const quant = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };

const rows: Row[] = [];
for (let k = 0; k < repeat; k++) for (const c of cases) {
  const row = await runCase(c);
  rows.push(row);
  console.log([row.pass ? 'PASS' : 'FAIL', c.tier, c.id.padEnd(22), row.outcome.padEnd(15), (row.driver || '-').padEnd(9), (row.login_ms / 1000).toFixed(1) + 's', row.model_calls ? row.model_calls + ' model calls' : '', row.error ?? ''].join('  '));
  writeFileSync(join(out, 'results.json'), JSON.stringify(rows, null, 2));
  if (c.tier === 'B') await new Promise(r => setTimeout(r, 3000));
}

const lines: string[] = ['# Login benchmark ' + runId, '', '| group | cases | pass | median login | p90 login | model used | model cost | median MB | cloud cost per login (est.) |', '|---|---|---|---|---|---|---|---|---|'];
const groups: [string, Row[]][] = [['A logged_in', rows.filter(r => r.tier === 'A' && r.expect === 'logged_in')], ['A rejected', rows.filter(r => r.tier === 'A' && r.expect === 'rejected')], ['A other', rows.filter(r => r.tier === 'A' && !['logged_in', 'rejected'].includes(r.expect))], ['B understood', rows.filter(r => r.tier === 'B')], ['all', rows]];
for (const [name, g] of groups) {
  if (!g.length) continue;
  const ms = g.map(r => r.login_ms);
  const cloudUsd = g.reduce((sum, r) => sum + r.browser_s / 3600 * CLOUD_USD_PER_HOUR + r.mb / 1000 * PROXY_USD_PER_GB, 0) / g.length;
  lines.push('| ' + [name, g.length, g.filter(r => r.pass).length + ' (' + pct(g.filter(r => r.pass).length, g.length) + ')', (quant(ms, 0.5) / 1000).toFixed(1) + 's', (quant(ms, 0.9) / 1000).toFixed(1) + 's',
    pct(g.filter(r => r.model_calls > 0).length, g.length), '$' + g.reduce((sum, r) => sum + r.model_usd, 0).toFixed(4), quant(g.map(r => r.mb), 0.5).toFixed(1), '$' + cloudUsd.toFixed(4)].join(' | ') + ' |');
}
lines.push('', '| case | expect | outcome | pass | driver | login | data | steps |', '|---|---|---|---|---|---|---|---|');
for (const r of rows) lines.push('| ' + [r.id, r.expect, r.outcome, r.pass ? 'yes' : '**no**', r.drivers_tried || '-', (r.login_ms / 1000).toFixed(1) + 's', r.mb.toFixed(1) + 'MB', (r.steps || r.error || '').replace(/\|/g, '/').slice(0, 90)].join(' | ') + ' |');
writeFileSync(join(out, 'summary.md'), lines.join('\n') + '\n');
console.log('\n' + lines.slice(0, 2 + groups.length + 2).join('\n') + '\nResults: ' + out);
process.exit(0);
