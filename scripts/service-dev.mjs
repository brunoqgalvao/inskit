// Local hosted service for development: wrangler dev plus the 10-minute cron that wrangler does not run by itself.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'service');
const port = process.env.PORT || '8795';
if (!existsSync(join(dir, '.dev.vars'))) {
  console.error('Missing service/.dev.vars with BROWSER_USE_API_KEY=... (see docs/self-host.md).');
  process.exit(1);
}
const wrangler = spawn('npx', ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', port, '--test-scheduled'], { cwd: dir, stdio: 'inherit' });
const tick = setInterval(() => {
  fetch('http://127.0.0.1:' + port + '/__scheduled?cron=*/10+*+*+*+*').catch(() => {});
}, 10 * 60_000);
const stop = () => { clearInterval(tick); wrangler.kill('SIGINT'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
wrangler.on('exit', code => { clearInterval(tick); process.exit(code ?? 0); });
