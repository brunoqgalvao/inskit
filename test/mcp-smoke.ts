// Starts the built plugin like Codex does (stdio MCP) and calls a few tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const pluginDir = resolve(process.argv[2] ?? 'plugin');
const home = mkdtempSync(join(tmpdir(), 'instinct-smoke-'));
const env = { ...process.env, INSTINCT_HOME: home, INSTINCT_BROWSER_PROVIDER: 'local', INSTINCT_PORT: '17793', INSTINCT_HEADLESS: '1', INSTINCT_COOKIE_SYNC: '0', INSTINCT_OPEN_LINKS: '0' } as Record<string, string>;
const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', join(pluginDir, 'dist/server.js')], cwd: pluginDir, env });
const client = new Client({ name: 'smoke', version: '1' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`tools: ${tools.length} (${tools.map(t => t.name).join(', ')})`);
console.log('instructions:', (client.getInstructions() ?? '').slice(0, 80) + '…');
const show = (r: any) => r.content.map((c: any) => c.text ?? '[image]').join('\n').slice(0, 400);
console.log(show(await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } })));
const shot = await client.callTool({ name: 'browser_screenshot', arguments: {} }) as any;
console.log('screenshot:', shot.content[0]?.type, Math.round((shot.content[0]?.data?.length ?? 0) / 1024) + 'KB');
console.log(show(await client.callTool({ name: 'agent_status', arguments: {} })));
const info = JSON.parse((await import('node:fs')).readFileSync(join(home, 'daemon.json'), 'utf8'));
await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } });
await client.close();
console.log('SMOKE OK');
