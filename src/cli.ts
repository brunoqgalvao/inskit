#!/usr/bin/env node
import './quiet.ts';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadConfig, superpowersKeyFile, SUPERPOWERS_URL } from './config.ts';
import { DaemonClient } from './client.ts';
import { detectBrowsers, listProfiles } from './browser-cookies.ts';
import { pushLogins } from './push.ts';
import { openInBrowser } from './service.ts';
import { BRAND, VERSION } from './brand.ts';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { Db } from './db.ts';
import { allRecipes, BUILT_IN } from './login/recipes.ts';
import { BrowserUseCloud } from './browser-use.ts';

const HELP = `${BRAND} for Codex ${VERSION}

  inskit status                      Browser, logins and vault status
  inskit check [--screenshot f.jpg]  Prove it works: open example.com in the agent browser, print the title, optionally save a screenshot
  inskit open                        Open the home page (add cards, ID, see purchases)
  inskit browsers                    Browsers and profiles logins can be imported from
  inskit logins import [--sites a.com,b.com | --all] [--browser chrome] [--profile "Work"]
                                       Copy logins from your browser into the agent browser
  inskit logins push <ssh-host> [--sites a.com,b.com | --all] [--cdp http://127.0.0.1:9222]
                                       Send logins to a browser on another machine over SSH
  inskit login-stats [--sites a.com]  Automatic login results per site: path used, success, time, model cost
  inskit recipes                     Login recipes in effect (built-in and ~/.instinct/recipes/*.json)
  inskit cloud status                Cloud browser usage: free tier today, or your Superpowers account this month
  inskit cloud forget                Delete the cloud browser profile and its cookies
  inskit superpowers login           Use your Superpowers account for the cloud browser (approve in the page that opens)
  inskit superpowers status          Balance, usage and prices on your Superpowers account
  inskit superpowers logout          Go back to the free cloud browser (your Superpowers profile stays until cloud forget)
  inskit stop                        Stop the background daemon and close the agent browser
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    sites: { type: 'string' }, all: { type: 'boolean' }, browser: { type: 'string' }, profile: { type: 'string' },
    cdp: { type: 'string', default: 'http://127.0.0.1:9222' }, help: { type: 'boolean', short: 'h' }, screenshot: { type: 'string' },
  },
});

const cfg = loadConfig();
const client = new DaemonClient(cfg);
const session = 'cli-' + randomUUID().slice(0, 8);
const sites = values.sites?.split(',').map(s => s.trim()).filter(Boolean);
const print = (r: { content: { type: string; text?: string }[]; isError?: boolean }) => {
  for (const c of r.content) if (c.type === 'text') console.log(c.text);
  if (r.isError) process.exitCode = 1;
};
const usd = (n: number) => 'US$' + (n >= 1 ? n.toFixed(2) : n.toFixed(3).replace(/0$/, ''));
function cloudStatus(kind: string, u: any) {
  if (kind === 'hosted') return 'Free cloud browser, install ' + u.id + ': ' + u.today.minutes + ' of ' + u.limits.minutes_per_day + ' minutes used today; sessions up to ' + u.limits.session_minutes + ' minutes.';
  return 'Superpowers cloud browser, account ' + u.account_id + ': balance ' + usd(u.balance_usd) + '. This month: ' + u.month.sessions + ' sessions, '
    + u.month.minutes + ' minutes, ' + u.month.proxy_mb + ' MB of proxy traffic, ' + usd(u.month.usd) + '. Price: ' + usd(u.price.per_minute_usd) + ' per minute plus '
    + usd(u.price.per_proxy_mb_usd) + ' per MB of proxy traffic; sessions up to ' + u.limits.session_minutes + ' minutes.' + (u.open_browser ? ' A browser is open until ' + u.open_browser.timeout_at + '.' : '');
}
/** Device sign-in: the person approves in their browser, the key comes back here once and is saved to a 0600 file. */
async function superpowersLogin() {
  const base = (process.env.INSKIT_SUPERPOWERS_URL || SUPERPOWERS_URL).replace(/\/+$/, '');
  const start = await fetch(base + '/v1/auth/device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'inskit on ' + hostname() }) });
  const d = await start.json().catch(() => ({})) as any;
  if (!start.ok || !d.device_code) throw new Error('Superpowers did not start the sign-in (HTTP ' + start.status + '). Try again in a minute.');
  const url = d.verification_url_complete ?? d.verification_url;
  console.log('Approve inskit on Superpowers: ' + url + '\nCode: ' + d.user_code + '  (new accounts get US$5 of credit)');
  await openInBrowser(url);
  const deadline = Date.now() + Number(d.expires_in ?? 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, Number(d.interval ?? 3) * 1000));
    const res = await fetch(base + '/v1/auth/device/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: d.device_code }) });
    if (res.status === 202) continue;
    const out = await res.json().catch(() => ({})) as any;
    if (res.status === 410) throw new Error('The sign-in code expired. Run inskit superpowers login again.');
    if (!res.ok || !out.api_key) throw new Error('Superpowers sign-in failed (HTTP ' + res.status + ').');
    const file = superpowersKeyFile(cfg.home);
    mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
    writeFileSync(file + '.tmp', out.api_key + '\n', { mode: 0o600 });
    renameSync(file + '.tmp', file);
    return base;
  }
  throw new Error('Nobody approved the sign-in in time. Run inskit superpowers login again.');
}

const [cmd, sub, arg] = positionals;
try {
  if (!cmd || values.help) console.log(HELP);
  else if (cmd === 'status') print(await client.call(session, 'agent_status', {}));
  else if (cmd === 'check') {
    const started = Date.now();
    const text = (r: { content: { type: string; text?: string }[] }) => r.content.map(c => c.text ?? '').join('\n');
    const nav = await client.call(session, 'browser_navigate', { url: 'https://example.com' }, { timeoutMs: 180_000 });
    const title = text(nav).match(/^Title: (.*)$/m)?.[1];
    const mode = text(await client.call(session, 'agent_status', {})).match(/^Agent browser: .*?\((.*)\)$/m)?.[1] ?? 'unknown browser';
    if (nav.isError || title !== 'Example Domain') {
      console.error('inskit check failed (' + mode + '): ' + text(nav).split('\n')[0]);
      process.exitCode = 1;
    } else {
      console.log('inskit works: opened example.com ("' + title + '") in ' + mode + ' in ' + ((Date.now() - started) / 1000).toFixed(1) + 's.');
      if (values.screenshot) {
        const shot = await client.call(session, 'browser_screenshot', {}) as { content: { type: string; data?: string }[] };
        const data = shot.content.find(c => c.type === 'image')?.data;
        if (data) { writeFileSync(values.screenshot, Buffer.from(data, 'base64')); console.log('Screenshot: ' + values.screenshot); }
      }
      console.log('Restart Codex (or open a new chat) and ask @inskit for a task.');
    }
  }
  else if (cmd === 'open') { await client.ensure(); await openInBrowser(cfg.publicUrl + '/'); console.log(cfg.publicUrl + '/'); }
  else if (cmd === 'browsers') {
    const found = detectBrowsers();
    if (!found.length) console.log('No Chromium-based browser found.');
    for (const b of found) console.log(`${b.name} (--browser ${b.id}): ${listProfiles(b).map(p => `"${p.name}"${p.lastUsed ? ' (last used)' : ''}`).join(', ')}`);
  }
  else if (cmd === 'logins' && sub === 'import') print(await client.call(session, 'logins_import', { sites, all: values.all, browser: values.browser, profile: values.profile }));
  else if (cmd === 'logins' && sub === 'push') {
    if (!arg) throw new Error('Usage: inskit logins push <ssh-host> --sites a.com,b.com | --all');
    const r = await pushLogins({ host: arg, cdp: values.cdp!, sites, all: values.all, browser: values.browser, profile: values.profile });
    console.log(`Sent ${r.sent} cookies from ${r.source} to ${arg} (${r.remoteBrowser}): ${r.accepted} accepted${r.rejected ? `, ${r.rejected} rejected` : ''}.`);
  }
  else if (cmd === 'login-stats') {
    const db = new Db(join(cfg.home, 'instinct.db'));
    const rows = db.sql.prepare(`select site, driver, outcome, count(*) n, cast(avg(ms) as integer) ms, sum(cost_usd) cost
      from login_runs group by site, driver, outcome order by site, n desc`).all() as any[];
    const filtered = sites?.length ? rows.filter(r => sites.some(x => r.site.includes(x))) : rows;
    if (!filtered.length) console.log('No automatic logins recorded yet.');
    for (const r of filtered) console.log(`${r.site.padEnd(24)} ${r.driver.padEnd(10)} ${r.outcome.padEnd(15)} ${String(r.n).padStart(4)}×  avg ${(r.ms / 1000).toFixed(1)}s  ${r.cost ? '$' + r.cost.toFixed(4) : ''}`);
    const learned = db.get<Record<string, string[]>>('login.learned_submit') ?? {};
    for (const [site, names] of Object.entries(learned)) console.log(`learned  ${site}: ${names.join(', ')}`);
    db.sql.close();
  }
  else if (cmd === 'recipes') {
    for (const r of allRecipes(cfg.home)) console.log(`${r.id.padEnd(14)} v${r.version}  ${BUILT_IN.includes(r) ? 'built-in' : 'file'}  ${r.sites.join(', ')}`);
    console.log(`Add or override: ${join(cfg.home, 'recipes')}/<id>.json (same id, higher version wins).`);
  }
  else if (cmd === 'stop') {
    const info = await client.ensure();
    await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } }).catch(() => {});
    console.log('Stopped.');
  }
  else if (cmd === 'cloud' && (sub === 'status' || sub === 'forget')) {
    const cloud = cfg.browserUse ? new BrowserUseCloud(cfg) : undefined;
    if (!cloud?.managed) console.log('No cloud browser service is in use here (' + (cfg.browserUse ? 'your own Browser Use key' : 'local or CDP browser') + ').');
    else if (sub === 'status') console.log(cloudStatus(cloud.kind, await cloud.usage()));
    else {
      await client.shutdown();
      const gone = await cloud.forget();
      console.log(!gone ? 'Nothing to delete.' : cloud.hosted ? 'Deleted your cloud browser profile and its cookies. A new anonymous install is created next time.'
        : 'Deleted your Superpowers cloud browser profile and its cookies. The next browser starts signed out of every site.');
    }
  }
  else if (cmd === 'superpowers' && sub === 'login') {
    const base = await superpowersLogin();
    await client.shutdown();
    const fresh = loadConfig();
    const which = fresh.browserUse?.superpowers ? 'inskit now uses your Superpowers cloud browser.' : 'Saved. Your current setting (' + (fresh.cdpUrl ? 'CDP' : fresh.browserUse ? 'your own Browser Use key' : 'local Chrome') + ') still wins; set INSTINCT_BROWSER_PROVIDER to "superpowers" to switch.';
    console.log('Signed in to Superpowers (' + base + '). ' + which + ' Sites you were logged in to on the free browser need one more sign-in there.');
    if (fresh.browserUse?.superpowers) console.log(cloudStatus('superpowers', await new BrowserUseCloud(fresh).usage()));
  }
  else if (cmd === 'superpowers' && sub === 'status') {
    if (!cfg.browserUse?.superpowers) console.log(existsSync(superpowersKeyFile(cfg.home)) ? 'Signed in, but another browser setting wins here.' : 'Not signed in. Run inskit superpowers login to use your Superpowers account.');
    else console.log(cloudStatus('superpowers', await new BrowserUseCloud(cfg).usage()));
  }
  else if (cmd === 'superpowers' && sub === 'logout') {
    const file = superpowersKeyFile(cfg.home);
    if (!existsSync(file)) console.log('Not signed in.');
    else {
      // Close the paid browser first so it stops billing.
      if (cfg.browserUse?.superpowers) {
        const state = join(cfg.home, 'superpowers-browser.json');
        const active = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')).activeId : undefined;
        await client.shutdown();
        if (active) await fetch(cfg.browserUse.superpowers.url + '/v1/browsers/' + encodeURIComponent(active), { method: 'DELETE', headers: { authorization: 'Bearer ' + cfg.browserUse.superpowers.apiKey } }).catch(() => {});
      }
      rmSync(file, { force: true });
      console.log('Signed out of Superpowers. inskit goes back to the free cloud browser. Your Superpowers browser profile stays on your account; revoke the key at https://superpowers.tools/app/keys if you no longer need it.');
    }
  }
  else { console.log(HELP); process.exitCode = 1; }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
