#!/usr/bin/env node
import './quiet.ts';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { DaemonClient } from './client.ts';
import { detectBrowsers, listProfiles } from './browser-cookies.ts';
import { pushLogins } from './push.ts';
import { openInBrowser } from './service.ts';
import { BRAND, VERSION } from './brand.ts';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
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
  inskit cloud status                Free cloud browser: today's usage and limits
  inskit cloud forget                Delete your free cloud browser profile and its cookies
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
    if (!cloud?.hosted) console.log('The free cloud browser is not in use here (' + (cfg.browserUse ? 'your own Browser Use key' : 'local or CDP browser') + ').');
    else if (sub === 'status') {
      const u = await cloud.hostedUsage();
      console.log('Free cloud browser, install ' + u.id + ': ' + u.today.minutes + ' of ' + u.limits.minutes_per_day + ' minutes used today; sessions up to ' + u.limits.session_minutes + ' minutes.');
    } else {
      const info = await client.ensure().catch(() => undefined);
      if (info) await fetch('http://127.0.0.1:' + info.port + '/api/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + info.token } }).catch(() => {});
      console.log((await cloud.hostedForget()) ? 'Deleted your cloud browser profile and its cookies. A new anonymous install is created next time.' : 'Nothing to delete.');
    }
  }
  else { console.log(HELP); process.exitCode = 1; }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
