import { db, sqlite } from "./connection";

/**
 * Idempotent schema bootstrap. DrizzleKit generates migrations, but for a
 * single-tenant personal service it's simpler to ensure tables exist at boot.
 */
export function ensureSchema(): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('income','expense','investment')),
      amount REAL NOT NULL,
      merchant TEXT NOT NULL,
      merchant_canonical TEXT,
      category TEXT,
      date TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      bank_name TEXT,
      parser_key TEXT,
      parsed_by TEXT NOT NULL CHECK(parsed_by IN ('regex','openrouter','failed','manual')),
      confidence TEXT NOT NULL CHECK(confidence IN ('high','medium','low')) DEFAULT 'medium',
      reference_number TEXT,
      account_last4 TEXT,
      fingerprint TEXT NOT NULL,
      source_message_guid TEXT NOT NULL UNIQUE,
      sync_status TEXT NOT NULL CHECK(sync_status IN ('pending','synced')) DEFAULT 'pending',
      synced_at TEXT,
      currency TEXT,
      original_amount REAL,
      needs_review INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migration: installs predating the 2026-07-17 repair pass lack the
  // currency/review/tombstone columns. Additive, idempotent.
  const txColumns = sqlite
    .query<{ name: string }, []>("PRAGMA table_info(transactions)")
    .all()
    .map((c) => c.name);
  for (const [name, ddl] of [
    ["currency", "ALTER TABLE transactions ADD COLUMN currency TEXT"],
    [
      "original_amount",
      "ALTER TABLE transactions ADD COLUMN original_amount REAL",
    ],
    [
      "needs_review",
      "ALTER TABLE transactions ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0",
    ],
    ["deleted_at", "ALTER TABLE transactions ADD COLUMN deleted_at TEXT"],
  ] as const) {
    if (!txColumns.includes(name)) db.run(ddl);
  }

  // Migration: older installs have parsed_by CHECK without 'manual'. Recreate
  // the table once if needed; SQLite does not support altering CHECK.
  const tableSql = sqlite
    .query<{ sql: string | null }, []>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'",
    )
    .get()?.sql;
  if (tableSql && !tableSql.includes("'manual'")) {
    db.run(`
      CREATE TABLE transactions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('income','expense','investment')),
        amount REAL NOT NULL,
        merchant TEXT NOT NULL,
        merchant_canonical TEXT,
        category TEXT,
        date TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        bank_name TEXT,
        parser_key TEXT,
        parsed_by TEXT NOT NULL CHECK(parsed_by IN ('regex','openrouter','failed','manual')),
        confidence TEXT NOT NULL CHECK(confidence IN ('high','medium','low')) DEFAULT 'medium',
        reference_number TEXT,
        account_last4 TEXT,
        fingerprint TEXT NOT NULL,
        source_message_guid TEXT NOT NULL UNIQUE,
        sync_status TEXT NOT NULL CHECK(sync_status IN ('pending','synced')) DEFAULT 'pending',
        synced_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    db.run(`
      INSERT INTO transactions_new SELECT
        id, type, amount, merchant, merchant_canonical, category, date, raw_text,
        sender_id, bank_name, parser_key, parsed_by, confidence, reference_number,
        account_last4, fingerprint, source_message_guid, sync_status, synced_at,
        created_at, updated_at
      FROM transactions;
    `);
    db.run(`DROP TABLE transactions;`);
    db.run(`ALTER TABLE transactions_new RENAME TO transactions;`);
  }

  db.run(`
    CREATE INDEX IF NOT EXISTS fingerprint_idx ON transactions(fingerprint);
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sender_allowlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_code TEXT NOT NULL UNIQUE,
      bank_name TEXT,
      parser_key TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );
  `);
  // Migration: older installs created this table with sender_id. Rename once.
  const columns = sqlite
    .query<{ name: string }, []>("PRAGMA table_info(sender_allowlist)")
    .all();
  if (
    columns.some((c) => c.name === "sender_id") &&
    !columns.some((c) => c.name === "bank_code")
  ) {
    db.run(
      `ALTER TABLE sender_allowlist RENAME COLUMN sender_id TO bank_code;`,
    );
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS merchant_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_pattern TEXT NOT NULL UNIQUE,
      canonical_merchant TEXT NOT NULL,
      category TEXT,
      source TEXT NOT NULL CHECK(source IN ('auto','manual')) DEFAULT 'auto',
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS merchant_aliases_raw_pattern_idx ON merchant_aliases(raw_pattern);
  `);
}
