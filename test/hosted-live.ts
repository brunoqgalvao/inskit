// Manual end-to-end check of the free hosted cloud browser from a fresh install (no key, empty home).
//   INSTINCT_HOSTED_URL=http://127.0.0.1:8795 node --import tsx test/hosted-live.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const home = mkdtempSync(join(tmpdir(), 'instinct-hosted-live-'));
for (const k of Object.keys(process.env)) if (k.startsWith('INSTINCT_') && k !== 'INSTINCT_HOSTED_URL' || k === 'BROWSER_USE_API_KEY') delete process.env[k];
Object.assign(process.env, { INSTINCT_HOME: home, INSTINCT_PORT: String(17000 + Math.floor(Math.random() * 600)), INSTINCT_OPEN_LINKS: '0' });
const { loadConfig } = await import('../src/config.ts');
const { DaemonClient } = await import('../src/client.ts');
const cfg = loadConfig();
console.log('provider:', cfg.browserUse?.hostedUrl ? 'hosted ' + cfg.browserUse.hostedUrl : 'not hosted');
const client = new DaemonClient(cfg);
const text = (r: any) => r.content.map((c: any) => c.text ?? '').join('\n');
const t0 = Date.now();
const nav = text(await client.call('live', 'browser_navigate', { url: 'https://example.com' }, { timeoutMs: 180_000 }));
console.log('navigate in', ((Date.now() - t0) / 1000).toFixed(1) + 's:', nav.split('\n').slice(0, 3).join(' | '));
console.log(text(await client.call('live', 'agent_status', {})).split('\n').filter((l: string) => /browser/i.test(l)).join('\n'));
const ho = text(await client.call('live', 'browser_hand_over', { reason: 'test' }));
console.log('hand over:', ho.replace(/https:\/\/\S+/, (m: string) => m.slice(0, 40) + '…'));
const cli = (...a: string[]) => execFileSync(process.execPath, ['--no-warnings', '--import', 'tsx', join(import.meta.dirname, '../src/cli.ts'), ...a], { env: process.env, encoding: 'utf8' }).trim();
console.log(cli('cloud', 'status'));
console.log(cli('cloud', 'forget'));
console.log('home:', home);
