// One-off: seed merchant_aliases from an app backup's curated categories,
// then retro-categorize existing mini transactions that landed in Other.
// Usage: bun run scripts/backfill-categories.ts /path/to/app-backup.db
import { Database } from "bun:sqlite";
import { db } from "../src/db/connection";
import {
  findAlias,
  normalizeMerchant,
  upsertAlias,
} from "../src/db/merchant-aliases";
import { transactions } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";

const appDbPath = process.argv[2];
if (!appDbPath) {
  console.error("usage: bun run scripts/backfill-categories.ts <app-backup.db>");
  process.exit(1);
}

const appDb = new Database(appDbPath, { readonly: true });

// 1. Mine merchant -> category from the app: majority vote per normalized
// merchant, ignoring Other/uncategorized. Keep the most common raw spelling
// as the canonical merchant.
interface Pair {
  merchant: string;
  category: string;
  n: number;
}
const pairs = appDb
  .query(
    `SELECT t.merchant AS merchant, c.name AS category, COUNT(*) AS n
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE t.merchant IS NOT NULL AND c.name != 'Other'
     GROUP BY t.merchant, c.name`,
  )
  .all() as Pair[];

const byPattern = new Map<
  string,
  { category: Map<string, number>; spelling: Map<string, number> }
>();
for (const p of pairs) {
  const pattern = normalizeMerchant(p.merchant);
  if (!pattern) continue;
  let entry = byPattern.get(pattern);
  if (!entry) {
    entry = { category: new Map(), spelling: new Map() };
    byPattern.set(pattern, entry);
  }
  entry.category.set(p.category, (entry.category.get(p.category) ?? 0) + p.n);
  entry.spelling.set(p.merchant, (entry.spelling.get(p.merchant) ?? 0) + p.n);
}

function top(m: Map<string, number>): [string, number] {
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0];
}

let seeded = 0;
for (const [pattern, entry] of byPattern) {
  const [category, votes] = top(entry.category);
  const [canonical] = top(entry.spelling);
  const total = [...entry.category.values()].reduce((a, b) => a + b, 0);
  // require a clear majority so ambiguous merchants (e.g. Instamart split
  // across Utilities/Food/Home) don't get a wrong hard rule
  if (votes / total < 0.6) continue;
  await upsertAlias({
    rawMerchant: pattern,
    canonicalMerchant: canonical,
    category,
    source: "manual",
  });
  seeded++;
}
console.log(`seeded ${seeded} aliases (of ${byPattern.size} merchants; rest ambiguous)`);

// 2. Retro-categorize mini rows stuck in Other/uncategorized.
const rows = await db
  .select({
    id: transactions.id,
    merchant: transactions.merchant,
    category: transactions.category,
  })
  .from(transactions)
  .where(
    sql`${transactions.parsedBy} != 'failed' AND (${transactions.category} IS NULL OR ${transactions.category} = 'Other')`,
  );

let updated = 0;
for (const row of rows) {
  const alias = await findAlias(row.merchant);
  if (!alias?.category) continue;
  await db
    .update(transactions)
    .set({
      category: alias.category,
      merchantCanonical: alias.canonicalMerchant,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(transactions.id, row.id));
  updated++;
}
console.log(`retro-categorized ${updated} of ${rows.length} Other/uncategorized rows`);
