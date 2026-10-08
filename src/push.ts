// Sends the user's local logins to a browser on another machine (a VM, a devbox, a cloud box running Codex).
// The cookies travel over the SSH channel's stdin and go straight into the remote browser over CDP.
import { spawn } from 'node:child_process';
import { readCookies } from './browser-cookies.ts';
import { hostOf, siteOf } from './vault.ts';

const RECEIVER = (cdp: string) => `(async () => {
  if (typeof WebSocket === 'undefined') throw new Error('Node 22+ is required on the remote machine');
  let data = ''; for await (const c of process.stdin) data += c;
  const cookies = JSON.parse(data);
  const v = await (await fetch(${JSON.stringify(cdp)} + '/json/version')).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP connection failed')); });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  let ok = 0, bad = 0;
  for (let i = 0; i < cookies.length; i += 100) {
    const batch = cookies.slice(i, i + 100);
    try { await send('Storage.setCookies', { cookies: batch }); ok += batch.length; }
    catch { for (const c of batch) { try { await send('Storage.setCookies', { cookies: [c] }); ok++; } catch { bad++; } } }
  }
  console.log(JSON.stringify({ ok, bad, browser: v.Browser }));
  ws.close(); process.exit(0);
})().catch(e => { console.error('remote: ' + e.message); process.exit(1); });`;

export async function pushLogins(opts: { host: string; cdp: string; sites?: string[]; all?: boolean; browser?: string; profile?: string }) {
  if (!opts.all && !opts.sites?.length) throw new Error('Choose what to send: --sites amazon.com,github.com or --all');
  const sites = (opts.sites ?? []).map(s => siteOf(hostOf(s) || s));
  const read = await readCookies({
    browser: opts.browser, profile: opts.profile,
    hostFilter: opts.all ? undefined : h => sites.includes(siteOf(h)),
  });
  const payload = JSON.stringify(read.cookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
    ...(c.expires > 0 ? { expires: c.expires } : {}),
  })));
  const script = Buffer.from(RECEIVER(opts.cdp)).toString('base64');
  const remote = `node -e "eval(Buffer.from('${script}','base64').toString())"`;
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', opts.host, remote], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error((err || out).trim() || `ssh exited with ${code}`))));
    child.stdin.end(payload);
  });
  const parsed = JSON.parse(result.split('\n').pop() || '{}');
  return { sent: read.cookies.length, accepted: parsed.ok as number, rejected: parsed.bad as number, remoteBrowser: parsed.browser as string, source: `${read.browser} (${read.profile})` };
}

