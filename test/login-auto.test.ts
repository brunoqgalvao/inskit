import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { Db } from '../src/db.ts';
import { Sealer } from '../src/crypto.ts';
import { Vault } from '../src/vault.ts';
import { Service } from '../src/service.ts';
import { Purchases } from '../src/purchases.ts';
import { loadConfig } from '../src/config.ts';
import { AgentBrowser } from '../src/browser.ts';

// A multi-step login like Mercado Livre: identifier page, password page, six one-digit code boxes that submit themselves.
const shell = (body: string) => '<!doctype html><meta charset=utf-8><body>' + body + '</body>';
const pages: Record<string, string> = {
  '/login': shell('<h1>Digite seu e-mail ou telefone</h1><label for=u>E-mail ou telefone</label><input id=u type=text><button id=next type=button>Continuar</button><button onclick="location=\'/google\'">Fazer Login com o Google</button><a href=/signup>Criar conta</a><script>next.onclick=()=>{next.disabled=true;setTimeout(()=>location=u.value==="fixture@example.com"?"/password":"/login?unknown",700)}</script>'),
  '/password': shell('<h1>Digite sua senha</h1><form id=f><label>Senha<input id=p type=password></label><button>Entrar</button></form><div id=err role=alert></div><script>f.onsubmit=e=>{e.preventDefault();if(p.value==="right-fixture-pass")setTimeout(()=>location="/code",400);else{err.textContent="Senha incorreta";p.value=""}}</script>'),
  '/code': shell('<h1>Insira o código que te enviamos por SMS</h1>' + [1,2,3,4,5,6].map(n => '<input class=d type=tel maxlength=1 aria-label="Dígito ' + n + '">').join('') + '<button id=c>Confirmar código</button><button>Reenviar código</button><script>const ds=[...document.querySelectorAll(".d")];const go=()=>{const v=ds.map(d=>d.value).join("");if(v.length<6)return;ds.forEach(d=>d.disabled=true);setTimeout(()=>location=v==="482691"?"/account":"/code?bad",500)};ds.forEach(d=>d.addEventListener("input",go));c.onclick=go</script>'),
  '/account': shell('<h1>Minhas compras</h1><a href=/logout>Sair</a>'),
  '/google': shell('<h1>Google</h1>'), '/signup': shell('<h1>Criar conta</h1>'),
};

async function setup() {
  const home = mkdtempSync('/tmp/inskit-autologin-');
  const browser = new AgentBrowser({ ...loadConfig(), home, browserUse: undefined, cdpUrl: undefined, headless: true, cookieSync: false });
  const db = new Db(':memory:'), vault = new Vault(db, Sealer.forTests());
  const service = new Service({ ...loadConfig(), openLinks: false, cookieSync: false }, db, browser, vault, new Purchases(db));
  const page = await browser.page('s');
  await page.route('https://login.example.com/**', route => route.fulfill({ contentType: 'text/html', body: pages[new URL(route.request().url()).pathname] ?? shell('missing') }));
  const call = async (name: string, args: any) => {
    const r = await service.call('s', name, args);
    const out = r.content.map((c: any) => c.text ?? '').join('\n');
    if (r.isError) throw new Error(out);
    return out;
  };
  const close = async () => { await browser.close(); db.sql.close(); rmSync(home, { recursive: true, force: true }); };
  return { browser, vault, service, call, page, close };
}

test('credentials arriving in the vault log in through every step, and the code is filled and confirmed automatically', async () => {
  const { vault, service, call, page, close } = await setup();
  try {
    await call('browser_navigate', { url: 'https://login.example.com/login' });
    const req = vault.createRequest({ kind: 'login', origin: 'https://login.example.com', purpose: 'Login' });
    const { itemId } = vault.submit(req.token, { username: 'fixture@example.com', password: 'right-fixture-pass' });
    const started = Date.now();
    const out = await call('vault_wait', { request_id: req.id, timeout_seconds: 5 });
    const elapsed = Date.now() - started;
    assert.match(out, /Outcome: code_requested .*\(username → submit → password → submit\)/);
    assert.ok(elapsed < 15_000, 'login steps took ' + elapsed + 'ms');
    assert.doesNotMatch(out, /right-fixture-pass|fixture@example\.com/);
    assert.equal(new URL(page.url()).pathname, '/code');
    assert.ok(vault.loginStatus(itemId)?.events?.some(e => e.stage === 'entering_password'));

    const msg = await call('vault_login_challenge', { item_id: itemId, method: 'code', channel: 'sms', instruction: 'Digite o código.', evidence: 'Insira o código que te enviamos por SMS' });
    const challengeId = msg.match(/challenge_id="([^"]+)/)![1];
    // The vault page starts the fill itself; no agent call is needed for the site to receive the code.
    vault.submitChallenge(req.token, challengeId, { code: '482691' });
    service.startAutoFill(challengeId);
    await page.waitForURL('**/account', { timeout: 15_000 });
    const done = await call('vault_challenge_wait', { challenge_id: challengeId, timeout_seconds: 5 });
    assert.match(done, /Code filled and confirmed automatically/);
    assert.match(done, /Minhas compras/);
    assert.doesNotMatch(done, /482691/);
    assert.throws(() => vault.takeChallengeCode(challengeId, 's', 'https://login.example.com/code'));
  } finally { await close(); }
});

test('a code read from the user mailbox is relayed, filled and confirmed without the vault page', async () => {
  const { vault, call, page, close } = await setup();
  try {
    await call('browser_navigate', { url: 'https://login.example.com/login' });
    const req = vault.createRequest({ kind: 'login', origin: 'https://login.example.com', purpose: 'Login' });
    const { itemId } = vault.submit(req.token, { username: 'fixture@example.com', password: 'right-fixture-pass' });
    assert.match(await call('vault_wait', { request_id: req.id, timeout_seconds: 5 }), /code_requested/);
    const msg = await call('vault_login_challenge', { item_id: itemId, method: 'code', channel: 'email', instruction: 'Código enviado por e-mail.', evidence: 'Insira o código que te enviamos por SMS' });
    const challengeId = msg.match(/challenge_id="([^"]+)/)![1];
    const out = await call('vault_challenge_code', { challenge_id: challengeId, code: '482691', source: 'email' });
    assert.match(out, /Code filled and confirmed automatically/);
    assert.doesNotMatch(out, /482691/);
    assert.equal(new URL(page.url()).pathname, '/account');
    await assert.rejects(call('vault_challenge_code', { challenge_id: challengeId, code: '482691', source: 'email' }));
  } finally { await close(); }
});


test('a rejected password is reported once and never resubmitted; social and signup buttons are never clicked', async () => {
  const { vault, call, page, close } = await setup();
  try {
    page.on('framenavigated', f => { if (f === page.mainFrame() && /google|signup/.test(f.url())) throw new Error('clicked wrong button'); });
    await call('browser_navigate', { url: 'https://login.example.com/login' });
    const req = vault.createRequest({ kind: 'login', origin: 'https://login.example.com', purpose: 'Login' });
    const { itemId } = vault.submit(req.token, { username: 'fixture@example.com', password: 'wrong-fixture-pass' });
    const out = await call('vault_login_attempt', { item_id: itemId, url: 'https://login.example.com/login' });
    assert.match(out, /Outcome: rejected/);
    assert.match(out, /Senha incorreta/);
    assert.match(out, /\(username → submit → password → submit\)/);
    assert.doesNotMatch(out, /wrong-fixture-pass/);
    assert.equal(new URL(page.url()).pathname, '/password');
  } finally { await close(); }
});

test('the automatic login refuses pages outside the saved login site', async () => {
  const { vault, call, close } = await setup();
  try {
    const req = vault.createRequest({ kind: 'login', origin: 'https://login.example.com', purpose: 'Login' });
    const { itemId } = vault.submit(req.token, { username: 'fixture@example.com', password: 'right-fixture-pass' });
    await assert.rejects(call('vault_login_attempt', { item_id: itemId, url: 'https://evil.example.net/login' }), /saved login site/);
  } finally { await close(); }
});
