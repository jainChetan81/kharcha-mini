// One-off: produce a fixed copy of an app backup with categories healed
// from the mini's merchant_aliases + retro-categorized transactions.
// Usage: bun run scripts/build-restore-backup.ts <app-backup.db> <output.db>
import { Database } from "bun:sqlite";
import { normalizeMerchant } from "../src/db/merchant-aliases";

const [src, out] = [process.argv[2], process.argv[3]];
if (!src || !out) {
  console.error("usage: bun run scripts/build-restore-backup.ts <src.db> <out.db>");
  process.exit(1);
}

await Bun.write(out, Bun.file(src));

const miniDbPath = `${process.env.HOME}/Desktop/code/kharcha-mini/data/kharcha-mini.db`;
const mini = new Database(miniDbPath, { readonly: true });
const app = new Database(out);

// app category name+type -> id
const catRows = app
  .query("SELECT id, name, type FROM categories")
  .all() as { id: number; name: string; type: string }[];
const catId = new Map(catRows.map((c) => [`${c.name}|${c.type}`, c.id]));
const otherIds = new Set(
  catRows.filter((c) => c.name === "Other").map((c) => c.id),
);

// 1. mini_synced rows: copy the mini's (now healed) category via mini_transaction_id
const miniCats = new Map(
  (
    mini
      .query(
        "SELECT id, category FROM transactions WHERE category IS NOT NULL AND category != 'Other'",
      )
      .all() as { id: number; category: string }[]
  ).map((r) => [r.id, r.category]),
);

const synced = app
  .query(
    `SELECT id, type, mini_transaction_id AS mid, category_id FROM transactions
     WHERE source_type = 'mini_synced' AND mini_transaction_id IS NOT NULL`,
  )
  .all() as { id: number; type: string; mid: number; category_id: number | null }[];

let healedSynced = 0;
const upd = app.prepare("UPDATE transactions SET category_id = ? WHERE id = ?");
app.exec("BEGIN");
for (const row of synced) {
  if (row.category_id !== null && !otherIds.has(row.category_id)) continue; // keep user edits
  const name = miniCats.get(row.mid);
  if (!name) continue;
  const id = catId.get(`${name}|${row.type}`);
  if (!id || id === row.category_id) continue;
  upd.run(id, row.id);
  healedSynced++;
}

// 2. app rows stuck in Other/NULL: categorize via mini merchant_aliases
const aliases = new Map(
  (
    mini
      .query(
        "SELECT raw_pattern, category FROM merchant_aliases WHERE category IS NOT NULL",
      )
      .all() as { raw_pattern: string; category: string }[]
  ).map((r) => [r.raw_pattern, r.category]),
);

const uncat = app
  .query(
    `SELECT id, type, merchant, category_id FROM transactions
     WHERE merchant IS NOT NULL
       AND (category_id IS NULL OR category_id IN (${[...otherIds].join(",")}))`,
  )
  .all() as { id: number; type: string; merchant: string; category_id: number | null }[];

let healedOther = 0;
for (const row of uncat) {
  const name = aliases.get(normalizeMerchant(row.merchant));
  if (!name) continue;
  const id = catId.get(`${name}|${row.type}`);
  if (!id || id === row.category_id) continue;
  upd.run(id, row.id);
  healedOther++;
}
app.exec("COMMIT");

console.log(
  `healed ${healedSynced} mini-synced rows, ${healedOther} Other/uncategorized rows`,
);

const summary = app
  .query(
    `SELECT c.name, t.type, COUNT(*) FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     GROUP BY 1,2 ORDER BY 3 DESC LIMIT 12`,
  )
  .all();
console.log(summary);
