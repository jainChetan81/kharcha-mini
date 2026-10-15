/**
 * Self-check for the change_seq cursor: run with
 * `bun run src/sync/change-seq.check.ts`.
 *
 * Opens a fresh in-memory DB, applies the same ensureSchema DDL (never the
 * live DB), and asserts the trigger/backfill contract push-vps relies on.
 */
import { Database } from "bun:sqlite";
import { ensureSchema } from "../db/bootstrap";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { transactions } from "../db/schema";

function assert(cond: unknown, label: string): void {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`ok: ${label}`);
}

const sqliteDb = new Database(":memory:");
ensureSchema(sqliteDb);
const db = drizzle(sqliteDb, { schema });

// Insert gets a seq.
db.insert(transactions)
  .values({
    type: "expense",
    amount: 10,
    merchant: "m1",
    date: "2026-10-15",
    rawText: "r",
    senderId: "s",
    fingerprint: "f1",
    sourceMessageGuid: "g1",
    parsedBy: "regex",
    confidence: "high",
  })
  .run();
const row1 = db.select().from(transactions).all()[0]!;
assert(
  typeof row1.changeSeq === "number" && row1.changeSeq > 0,
  `insert gets change_seq (${row1.changeSeq})`,
);

const seqAfterInsert = sqliteDb
  .query<{ seq: number }, []>("SELECT seq FROM change_counter WHERE id = 1")
  .get()!.seq;
assert(
  seqAfterInsert === row1.changeSeq,
  "counter equals max change_seq after insert",
);

// Raw-SQL UPDATE bumps seq above all prior.
sqliteDb.run(
  "UPDATE transactions SET deleted_at = '2026-10-15T00:00:00Z' WHERE id = 1",
);
const row2 = db.select().from(transactions).all()[0]!;
assert(
  (row2.changeSeq ?? 0) > (row1.changeSeq ?? 0),
  `raw-SQL update bumps change_seq (${row1.changeSeq} -> ${row2.changeSeq})`,
);

// Trigger does not loop: counter moved by exactly 1 for one update.
const seqAfterUpdate = sqliteDb
  .query<{ seq: number }, []>("SELECT seq FROM change_counter WHERE id = 1")
  .get()!.seq;
assert(
  seqAfterUpdate === (row2.changeSeq ?? 0),
  "trigger did not loop (counter == row change_seq)",
);

// Backfill is idempotent on second ensureSchema call.
sqliteDb.run("INSERT INTO transactions (id, type, amount, merchant, date, raw_text, sender_id, fingerprint, source_message_guid, parsed_by) VALUES (999, 'expense', 1, 'legacy', '2026-10-15', 'r', 's', 'f999', 'g999', 'regex')");
// Simulate pre-trigger row with NULL change_seq (bypasses insert trigger).
sqliteDb.run("UPDATE transactions SET change_seq = NULL WHERE id = 999");
ensureSchema(sqliteDb);
const backfilled = sqliteDb
  .query<{ change_seq: number | null }, []>(
    "SELECT change_seq FROM transactions WHERE id = 999",
  )
  .get()!;
assert(
  backfilled.change_seq !== null,
  "backfill assigns change_seq to NULL rows",
);
ensureSchema(sqliteDb);
const afterSecond = sqliteDb
  .query<{ change_seq: number | null }, []>(
    "SELECT change_seq FROM transactions WHERE id = 999",
  )
  .get()!;
const counter = sqliteDb
  .query<{ seq: number }, []>("SELECT seq FROM change_counter WHERE id = 1")
  .get()!.seq;
const maxSeq = sqliteDb
  .query<{ m: number | null }, []>("SELECT MAX(change_seq) AS m FROM transactions")
  .get()!.m;
assert(
  afterSecond.change_seq === backfilled.change_seq,
  "backfill is idempotent (second ensureSchema leaves values)",
);
assert(
  counter === maxSeq,
  `counter (${counter}) equals max change_seq (${maxSeq})`,
);

console.log("change-seq self-check: all assertions passed");
