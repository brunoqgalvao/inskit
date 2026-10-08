// Loaded lazily so the "SQLite is experimental" warning filter (quiet.ts) is installed first.
import { createRequire } from 'node:module';
import type * as Sqlite from 'node:sqlite';

export function sqlite(): typeof Sqlite {
  return createRequire(import.meta.url)('node:sqlite');
}
