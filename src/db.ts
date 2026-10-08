import type { DatabaseSync } from 'node:sqlite';
import { sqlite } from './sqlite.ts';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const schema = `
create table if not exists kv (key text primary key, value text not null);
create table if not exists vault_items (
  id text primary key, kind text not null, label text not null, origin text,
  public text not null, envelope text not null, created_at integer not null, updated_at integer not null
);
create table if not exists orders (
  id text primary key, status text not null, store_name text not null, store_url text not null,
  store_host text not null, currency text not null, quote text not null, total_cents integer not null,
  approval_evidence text, approved_at integer, submitted_at integer, confirmed_at integer,
  store_order_number text, paid_total_cents integer, failure text,
  created_at integer not null, updated_at integer not null
);
create table if not exists login_runs (
  id integer primary key autoincrement, site text not null, driver text not null, drivers_tried text not null, outcome text not null,
  ms integer not null, steps text not null, model text, input_tokens integer not null, output_tokens integer not null, cost_usd real not null,
  recipe text, created_at integer not null
);
create table if not exists cookie_sync (site text primary key, count integer not null, imported_at integer not null);
create table if not exists audit (
  id integer primary key autoincrement, type text not null, data text not null, created_at integer not null
);
`;

export class Db {
  readonly sql: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new (sqlite().DatabaseSync)(path);
    this.sql.exec('pragma journal_mode = wal; pragma busy_timeout = 3000;');
    this.sql.exec(schema);
  }

  get<T>(key: string): T | undefined {
    const row = this.sql.prepare('select value from kv where key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  set(key: string, value: unknown) {
    this.sql.prepare('insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  audit(type: string, data: unknown) {
    this.sql.prepare('insert into audit (type, data, created_at) values (?, ?, ?)').run(type, JSON.stringify(data), Date.now());
  }
}
