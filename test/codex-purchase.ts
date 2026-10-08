// Full model-driven purchase through real Codex (codex exec) on the fixture store.
// A fake "open" command captures pages the plugin opens for the human; this script plays the human.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureStore } from './fixture-store.ts';

const home = mkdtempSync(join(tmpdir(), 'instinct-codex-buy-'));
const bin = join(home, 'bin');
const opened = join(home, 'opened.txt');
(await import('node:fs')).mkdirSync(bin);
writeFileSync(join(bin, 'open'), `#!/bin/sh\necho "$1" >> ${opened}\n`);
chmodSync(join(bin, 'open'), 0o755);
const port = '17797';
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTINCT_HOME: home, INSTINCT_BROWSER_PROVIDER: 'local', INSTINCT_PORT: port, INSTINCT_HEADLESS: '1', INSTINCT_COOKIE_SYNC: '0', INSTINCT_OPEN_LINKS: '1' };
const base = `http://127.0.0.1:${port}`;
const store = await startFixtureStore(17798);
const cli = join(import.meta.dirname, '../plugin/dist/cli.js');
const run = (cmd: string, args: string[], extra: object = {}) => new Promise<string>((resolve, reject) => {
  const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], ...extra });
  let out = '';
  child.stdout?.on('data', d => (out += d));
  child.stderr?.on('data', d => (out += d));
  child.on('close', () => resolve(out));
  child.on('error', reject);
});

// Seed: start daemon, save a card and the profile like a user would on the home page.
console.log(await run(process.execPath, [cli, 'status']));
const res = await fetch(base + '/new/card', { redirect: 'manual' });
const vaultUrl = base + res.headers.get('location');
const saved = await fetch(vaultUrl, { method: 'POST', headers: { origin: base }, body: new URLSearchParams({ number: '4111111111111111', expiry: '12/30', cvv: '123', holder: 'Ada Lovelace', rememberCvv: 'on', label: 'Personal Visa' }) });
console.log('card saved:', saved.status);

// The human: approve any approval page the plugin opens.
const decided = new Set<string>();
const human = setInterval(async () => {
  if (!existsSync(opened)) return;
  for (const url of readFileSync(opened, 'utf8').split('\n').filter(Boolean)) {
    if (decided.has(url)) continue;
    decided.add(url);
    const page = await (await fetch(url)).text();
    const total = page.match(/Total<\/td><td>([^<]+)/)?.[1];
    console.log(`[human] opened ${url.replace(/[\w-]{20,}$/, '…')} total=${total}`);
    if (url.includes('/a/')) {
      const r = await fetch(url, { method: 'POST', headers: { origin: base }, body: new URLSearchParams({ decision: 'approve' }) });
      console.log('[human] approved:', r.status);
    }
  }
}, 500);

const prompt = `Buy the Espresso Machine at ${store.url} using my saved Personal Visa. Ship to Rua Teste 1, São Paulo. Go ahead, I'll approve.`;
const out = await run('codex', ['exec', '--skip-git-repo-check', '-C', home, prompt]);
clearInterval(human);
console.log(out.split('\n').slice(-25).join('\n'));
const status = await run(process.execPath, [cli, 'status']);
const orders = (await (await fetch(base + '/')).text()).match(/Fixture Store[^<]*<\/span><span class=pill>([^<]+)/)?.[1];
console.log('order status on home page:', orders);
console.log(readFileSync(join(home, 'clients.log'), 'utf8'));
await run(process.execPath, [cli, 'stop']);
store.close();
