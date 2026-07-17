import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export let DB_PATH = "";

let sqliteInstance: Database | undefined;
let dbInstance: BunSQLiteDatabase<typeof schema> | undefined;

function ensureConnection(): void {
  if (sqliteInstance) return;

  DB_PATH =
    process.env.KHARCHA_MINI_DB ??
    `${process.env.HOME}/Desktop/code/kharcha-mini/data/kharcha-mini.db`;

  // Ensure the data directory exists before SQLite tries to create the file.
  mkdirSync(dirname(DB_PATH), { recursive: true });

  sqliteInstance = new Database(DB_PATH, { create: true });

  // Tune SQLite for a single-user, launchd-polled ingestion workload:
  //   - journal_mode WAL: keeps reads from blocking writes and vice-versa.
  //   - synchronous NORMAL: safe with WAL; fsync only on checkpoint.
  //   - temp_store MEMORY: temp tables/spills stay in RAM for our dataset size.
  //   - cache_size -4000: 4 MB page cache, enough for hot allowlist/config rows.
  sqliteInstance.exec("PRAGMA journal_mode = WAL;");
  sqliteInstance.exec("PRAGMA synchronous = NORMAL;");
  sqliteInstance.exec("PRAGMA temp_store = MEMORY;");
  sqliteInstance.exec("PRAGMA cache_size = -4000;");

  dbInstance = drizzle(sqliteInstance, { schema });
}

function createLazyProxy<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_, prop) {
      const target = resolve();
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  });
}

export const db = createLazyProxy<BunSQLiteDatabase<typeof schema>>(() => {
  ensureConnection();
  return dbInstance!;
});

// Exposed for raw introspection / one-off migrations in bootstrap.
export const sqlite = createLazyProxy<Database>(() => {
  ensureConnection();
  return sqliteInstance!;
});

export function checkpointWal(): void {
  try {
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // Best-effort; a missed checkpoint degrades to prior behaviour.
  }
}
