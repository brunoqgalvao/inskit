// Finds or starts the daemon and calls it. Used by the MCP shim and the CLI.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.ts';
import { BUILD_ID } from './brand.ts';
import type { ToolResult } from './tools.ts';

type DaemonInfo = { port: number; token: string; pid: number; build: string };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function newer(a: string, b: string) {
  return /^\d+$/.test(a) && /^\d+$/.test(b) && Number(a) > Number(b);
}

export class DaemonClient {
  private info?: DaemonInfo;
  constructor(private cfg: Config) {}

  private readInfo(): DaemonInfo | undefined {
    try { return JSON.parse(readFileSync(join(this.cfg.home, 'daemon.json'), 'utf8')); } catch { return undefined; }
  }

  private async health() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.cfg.port}/api/health`, { signal: AbortSignal.timeout(1500) });
      return res.ok ? ((await res.json()) as { build: string; pid: number }) : undefined;
    } catch { return undefined; }
  }

  private spawnDaemon() {
    const here = dirname(fileURLToPath(import.meta.url));
    const ts = import.meta.url.endsWith('.ts');
    const entry = join(here, ts ? 'daemon.ts' : 'daemon.js');
    if (!existsSync(entry)) throw new Error(`daemon entry missing: ${entry}`);
    mkdirSync(this.cfg.home, { recursive: true, mode: 0o700 });
    const log = openSync(join(this.cfg.home, 'daemon.log'), 'a');
    const args = ['--no-warnings', ...(ts ? ['--import', 'tsx'] : []), entry];
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], env: process.env, cwd: here });
    child.unref();
  }

  async ensure(): Promise<DaemonInfo> {
    let health = await this.health();
    if (health && newer(BUILD_ID, health.build)) {
      // A newer plugin build replaces the running daemon.
      const info = this.readInfo();
      if (info) await fetch(`http://127.0.0.1:${this.cfg.port}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } }).catch(() => {});
      for (let i = 0; i < 20 && (await this.health()); i++) await sleep(250);
      health = undefined;
    }
    if (!health) {
      this.spawnDaemon();
      for (let i = 0; i < 80; i++) {
        await sleep(250);
        health = await this.health();
        if (health) break;
      }
      if (!health) throw new Error(`The local agent daemon did not start. See ${join(this.cfg.home, 'daemon.log')}`);
    }
    const info = this.readInfo();
    if (!info || info.pid !== health.pid) {
      for (let i = 0; i < 20; i++) { await sleep(150); const again = this.readInfo(); if (again?.pid === health.pid) { this.info = again; return again; } }
      throw new Error('Daemon info file is out of date.');
    }
    this.info = info;
    return info;
  }

  async call(session: string, name: string, args: unknown, opts: { nativeApproval?: boolean; timeoutMs?: number } = {}): Promise<ToolResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const info = this.info ?? (await this.ensure());
      try {
        const res = await fetch(`http://127.0.0.1:${info.port}/api/call`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
          body: JSON.stringify({ session, name, args, nativeApproval: opts.nativeApproval }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        });
        if (res.status === 401) { this.info = undefined; continue; }
        return (await res.json()) as ToolResult;
      } catch (error) {
        if (attempt === 0 && !(error instanceof DOMException && error.name === 'TimeoutError')) { this.info = undefined; continue; }
        throw error;
      }
    }
    throw new Error('Could not reach the local agent daemon.');
  }
}

