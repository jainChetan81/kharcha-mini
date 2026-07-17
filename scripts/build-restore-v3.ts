// Build a healed app-restore file reflecting the 2026-07-17 repair pass:
// - delete app rows whose mini twin is tombstoned (OTP double-counts, ghosts)
// - heal merchant/category/amount on mini-synced rows (USD fixes included)
// - insert repair-recovered rows (salary NEFT credits etc.) the pull path
//   can't deliver (their ids sit behind the app's sync cursor)
// - convert to rollback-journal mode so the app's import preview accepts it
// Usage: bun run scripts/build-restore-v3.ts <app-backup.db> <output.db>
import { Database } from "bun:sqlite";

const [src, out] = [process.argv[2], process.argv[3]];
if (!src || !out) {
  console.error("usage: bun run scripts/build-restore-v3.ts <src.db> <out.db>");
  process.exit(1);
}

await Bun.write(out, Bun.file(src));
const miniPath = `${process.env.HOME}/Desktop/code/kharcha-mini/data/kharcha-mini.db`;
const mini = new Database(miniPath, { readonly: true });
const app = new Database(out);

interface MiniRow {
  id: number;
  type: string;
  amount: number;
  merchant: string;
  category: string | null;
  date: string;
  parsed_by: string;
  reference_number: string | null;
  deleted_at: string | null;
  currency: string | null;
}
const miniRows = mini
  .query(
    `SELECT id, type, amount, merchant, category, date, parsed_by,
            reference_number, deleted_at, currency
     FROM transactions`,
  )
  .all() as MiniRow[];
const byMiniId = new Map(miniRows.map((r) => [r.id, r]));

const catRows = app
  .query("SELECT id, name, type FROM categories")
  .all() as { id: number; name: string; type: string }[];
const catId = new Map(catRows.map((c) => [`${c.name}|${c.type}`, c.id]));
const otherIds = new Set(
  catRows.filter((c) => c.name === "Other").map((c) => c.id),
);

const appRows = app
  .query(
    `SELECT id, type, amount, merchant, category_id, mini_transaction_id AS mid
     FROM transactions WHERE mini_transaction_id IS NOT NULL`,
  )
  .all() as {
  id: number;
  type: string;
  amount: number;
  merchant: string | null;
  category_id: number | null;
  mid: number;
}[];
const appMiniIds = new Set(appRows.map((r) => r.mid));

let removed = 0;
let healed = 0;
let inserted = 0;
app.exec("BEGIN");

const del = app.prepare("DELETE FROM transactions WHERE id = ?");
const upd = app.prepare(
  "UPDATE transactions SET merchant = ?, category_id = ?, amount = ?, type = ?, date = ? WHERE id = ?",
);

const appDates = new Map(
  (
    app.query("SELECT id, date FROM transactions WHERE mini_transaction_id IS NOT NULL").all() as {
      id: number;
      date: string;
    }[]
  ).map((r) => [r.id, r.date]),
);

for (const row of appRows) {
  const m = byMiniId.get(row.mid);
  if (!m) continue;
  if (m.deleted_at) {
    del.run(row.id);
    removed++;
    continue;
  }
  const keepCat =
    row.category_id !== null && !otherIds.has(row.category_id)
      ? row.category_id
      : (m.category && catId.get(`${m.category}|${m.type}`)) ??
        row.category_id;
  // Heal the date when the mini has a real time-of-day and the app copy lost
  // it (old sync builds truncated to date-only, which the app then renders as
  // 05:30 IST — UTC-midnight artifact).
  const appDate = appDates.get(row.id) ?? "";
  const miniHasTime = m.date.length > 10 && !m.date.endsWith(" 00:00");
  const keepDate = miniHasTime && appDate !== m.date ? m.date : appDate;
  const changed =
    m.merchant !== row.merchant ||
    keepCat !== row.category_id ||
    Math.abs(m.amount - row.amount) > 0.005 ||
    m.type !== row.type ||
    keepDate !== appDate;
  if (changed) {
    upd.run(m.merchant, keepCat, m.amount, m.type, keepDate, row.id);
    healed++;
  }
}

// Recovered rows (openrouter-recovered by the repair) missing from the app.
const ins = app.prepare(
  `INSERT INTO transactions
     (type, amount, merchant, category_id, source_type, parsed_by, date, note,
      mini_transaction_id, reference_number)
   VALUES (?, ?, ?, ?, 'mini_synced', 'openrouter', ?, ?, ?, ?)`,
);
for (const m of miniRows) {
  if (m.deleted_at || m.parsed_by !== "openrouter") continue;
  if (appMiniIds.has(m.id)) continue;
  ins.run(
    m.type,
    m.amount,
    m.merchant,
    m.category ? (catId.get(`${m.category}|${m.type}`) ?? null) : null,
    m.date,
    m.currency ? `recovered · ${m.currency}` : "recovered by repair pass",
    m.id,
    m.reference_number,
  );
  inserted++;
}
app.exec("COMMIT");
app.exec("PRAGMA wal_checkpoint(TRUNCATE)");
app.exec("PRAGMA journal_mode=DELETE");

console.log(`removed ${removed}, healed ${healed}, inserted ${inserted}`);
console.log(app.query("PRAGMA integrity_check").get());
console.log(app.query("SELECT count(*) n FROM transactions").get());
console.log(
  app
    .query(
      `SELECT c.name, count(*) n FROM transactions t
       JOIN categories c ON c.id = t.category_id
       WHERE t.type='income' GROUP BY 1 ORDER BY 2 DESC`,
    )
    .all(),
);
app.close();
