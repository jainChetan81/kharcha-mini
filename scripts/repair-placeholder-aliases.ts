// One-off repair (2026-11-25): rows renamed by an alias on a parser placeholder
// ("Card Payment" -> Openrouter, "UPI Payment" -> Mahima Snacks & Tea).
// Re-reads the merchant from raw_text with the fixed parsers. Dry run unless --apply.
import { Database } from "bun:sqlite";
import { parseMessage } from "../src/parsers/index";
import { isGenericPlaceholder } from "../src/ingest/proofread";

const apply = process.argv.includes("--apply");
const db = new Database(process.env.KHARCHA_MINI_DB ?? "data/kharcha-mini.db");
const rows = db
  .query(
    `SELECT id, merchant, category, parser_key, raw_text FROM transactions
     WHERE deleted_at IS NULL AND parsed_by = 'regex'
       AND merchant IN ('Openrouter','Mahima Snacks & Tea','UPI Payment','Card Payment')`,
  )
  .all() as { id: number; merchant: string; category: string | null; parser_key: string | null; raw_text: string }[];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
let changed = 0;
for (const row of rows) {
  const parsed = parseMessage(row.parser_key, row.raw_text).parsed;
  if (!parsed || isGenericPlaceholder(parsed.merchant) || norm(parsed.merchant) === norm(row.merchant)) continue;
  const category = parsed.category ?? row.category ?? "Other";
  console.log(`${row.id}: "${row.merchant}" -> "${parsed.merchant}" (${row.category} -> ${category})`);
  changed++;
  if (apply)
    db.run("UPDATE transactions SET merchant = ?, category = ?, updated_at = datetime('now') WHERE id = ?", [parsed.merchant, category, row.id]);
}
if (apply) {
  const gone = db.run("DELETE FROM merchant_aliases WHERE raw_pattern IN ('CARD PAYMENT','UPI PAYMENT','CREDIT','CREDIT CARD PAYMENT','HDFC CARD PAYMENT','HDFC CREDIT','IMPS CREDIT','UPI CREDIT','NEFT CREDIT','PAYMENT','UNKNOWN')");
  console.log(`deleted ${gone.changes} placeholder alias(es)`);
}
console.log(`${apply ? "updated" : "would update"} ${changed} of ${rows.length} row(s)`);
