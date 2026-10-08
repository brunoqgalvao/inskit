// Manual check on a real machine: first visit to a site imports its logins from the everyday browser.
import { writeFileSync } from 'node:fs';
const site = process.argv[2] ?? 'https://github.com';
const out = process.argv[3];
Object.assign(process.env, { INSTINCT_HOME: process.env.INSTINCT_HOME ?? '/tmp/instinct-live', INSTINCT_PORT: process.env.INSTINCT_PORT ?? '17794', INSTINCT_OPEN_LINKS: '0' });
const { loadConfig } = await import('../src/config.ts');
const { DaemonClient } = await import('../src/client.ts');
const client = new DaemonClient(loadConfig());
const text = (r: any) => r.content.map((c: any) => c.text ?? '').join('\n');
const nav = await client.call('live', 'browser_navigate', { url: site }, { timeoutMs: 180_000 });
const t = text(nav);
console.log(t.split('\n').slice(0, 3).join('\n'));
console.log('signed-in hints:', /Sign out|Dashboard|Your repositories|Signed in as|avatar|Open user navigation/i.test(t), '| sign-in button:', /link "Sign in"|button "Sign in"/i.test(t));
if (out) {
  const shot: any = await client.call('live', 'browser_screenshot', {});
  if (shot.content[0]?.data) writeFileSync(out, Buffer.from(shot.content[0].data, 'base64'));
}
console.log(text(await client.call('live', 'agent_status', {})));

