import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from '../src/db.ts';
import { Sealer } from '../src/crypto.ts';
import { Vault } from '../src/vault.ts';
import { Service } from '../src/service.ts';
import { Purchases } from '../src/purchases.ts';
import { loadConfig } from '../src/config.ts';
import { AgentBrowser } from '../src/browser.ts';

const shell = (body: string) => '<!doctype html><meta charset=utf-8><body>' + body + '</body>';
// The sign-in control is a span with role=button and an unusual label: generic heuristics cannot pick it.
const pages: Record<string, string> = {
  '/login': shell('<h1>Entre</h1><label>Usuário <input id=u type=text></label><label>Senha <input id=p type=password></label><span role=button tabindex=0 id=go>Acessar minha conta</span><script>go.onclick=()=>{location=p.value==="right-pass"?"/home":"/login?bad"}</script>'),
  '/home': shell('<h1>Olá, Fixture</h1><a href=/logout>Sair</a>'),
  '/captcha-login': shell('<label>E-mail <input type=email id=e></label><button onclick="location=\'/captcha\'">Continuar</button>'),
  '/captcha': shell('<h1>Confirme</h1><iframe src="https://www.google.com/recaptcha/api2/anchor?k=x" width=300 height=80></iframe>'),
  '/chooser-login': shell('<label>E-mail <input type=email id=e></label><button onclick="location=\'/chooser\'">Continuar</button>'),
  '/chooser': shell('<h1>Escolha um método de verificação</h1><button onclick="location=\'/qr\'">Código QR</button><button onclick="location=\'/code\'">SMS Enviaremos um código</button>'),
  '/code': shell('<h1>Insira o código</h1><input autocomplete=one-time-code aria-label="Código">'),
};

async function setup() {
  const home = mkdtempSync('/tmp/inskit-chain-');
  // A user recipe file: the update path that needs no release.
  mkdirSync(join(home, 'recipes'));
  writeFileSync(join(home, 'recipes', 'chain.json'), JSON.stringify({ id: 'chain', version: 1, sites: ['chain.example.com'], chooser: ['Escolha um método'], preferMethod: ['SMS'] }));
  const browser = new AgentBrowser({ ...loadConfig(), home, browserUse: undefined, cdpUrl: undefined, headless: true, cookieSync: false });
  const db = new Db(':memory:'), vault = new Vault(db, Sealer.forTests());
  const service = new Service({ ...loadConfig(), home, openLinks: false, cookieSync: false }, db, browser, vault, new Purchases(db));
  const page = await browser.page('s');
  await page.route('https://chain.example.com/**', route => route.fulfill({ contentType: 'text/html', body: pages[new URL(route.request().url()).pathname] ?? shell('missing') }));
  await page.route('https://www.google.com/recaptcha/**', route => route.fulfill({ contentType: 'text/html', body: shell('captcha') }));
  const attempt = async (url: string, password = 'right-pass', model_fallback = 'luna') => {
    const req = vault.createRequest({ kind: 'login', origin: 'https://chain.example.com', purpose: 'Login' });
    const { itemId } = vault.submit(req.token, { username: 'fixture@example.com', password });
    const r = await service.call('s', 'vault_login_attempt', { item_id: itemId, url, model_fallback });
    return { text: r.content.map((c: any) => c.text ?? '').join('\n'), data: r.structuredContent as any };
  };
  const close = async () => { await browser.close(); db.sql.close(); rmSync(home, { recursive: true, force: true }); };
  return { db, attempt, close };
}

// Stands in for the inner model: answers from the snapshot it is shown, like a real model would.
function fakeModel() {
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    calls++;
    const prompt: string = JSON.parse(body).input[0].content[0].text;
    const ref = (name: string) => prompt.split('\n').find(l => l.includes(name) && l.includes('[ref='))?.match(/\[ref=([^\]]+)\]/)?.[1];
    const done = prompt.match(/Actions so far: (.*)/)?.[1] ?? '';
    let action: any;
    if (prompt.includes('link "Sair"')) action = { action: 'done', outcome: 'logged_in', reason: 'Sair link' };
    else if (!done.includes('username')) action = { action: 'fill', ref: ref('textbox "Usuário"'), field: 'username' };
    else if (!done.includes('password')) action = { action: 'fill', ref: ref('textbox "Senha"'), field: 'password' };
    else action = { action: 'click', ref: ref('button "Acessar minha conta"') };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output_text: JSON.stringify(action), usage: { input_tokens: 500, output_tokens: 20 } }));
  });
  return new Promise<{ url: string; calls: () => number; close: () => void }>(resolve => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as any).port;
    resolve({ url: 'http://127.0.0.1:' + port + '/v1', calls: () => calls, close: () => server.close() });
  }));
}

test('unreadable form falls back to the model, which logs in; the next run reuses what it learned without the model', async () => {
  const model = await fakeModel();
  process.env.INSKIT_LUNA_BASE_URL = model.url;
  const { db, attempt, close } = await setup();
  try {
    const first = await attempt('https://chain.example.com/login');
    assert.equal(first.data.outcome, 'logged_in', first.text);
    assert.equal(first.data.driver, 'model');
    assert.deepEqual(first.data.drivers_tried, ['recipe', 'model']);
    assert.ok(first.data.model.calls >= 4);
    assert.doesNotMatch(first.text, /right-pass|fixture@example\.com/);
    const used = model.calls();
    const second = await attempt('https://chain.example.com/login');
    assert.equal(second.data.outcome, 'logged_in', second.text);
    assert.equal(second.data.driver, 'recipe');
    assert.equal(model.calls(), used, 'second run must not call the model');
    const runs = db.sql.prepare('select driver, outcome from login_runs order by id').all() as any[];
    assert.deepEqual(runs.map(r => r.driver + ':' + r.outcome), ['model:logged_in', 'recipe:logged_in']);
  } finally { await close(); model.close(); delete process.env.INSKIT_LUNA_BASE_URL; }
});

test('a visible CAPTCHA goes to the human without calling the model', async () => {
  const { attempt, close } = await setup();
  try {
    const r = await attempt('https://chain.example.com/captcha-login', 'x', 'haiku');
    assert.equal(r.data.outcome, 'needs_human', r.text);
    assert.deepEqual(r.data.drivers_tried, ['recipe']);
  } finally { await close(); }
});

test('a recipe picks the preferred verification method and reaches the code step', async () => {
  const { attempt, close } = await setup();
  try {
    const r = await attempt('https://chain.example.com/chooser-login', 'x', 'off');
    assert.equal(r.data.outcome, 'code_requested', r.text);
    assert.ok(r.data.steps.includes('method SMS Enviaremos um código'), r.data.steps.join(','));
  } finally { await close(); }
});

