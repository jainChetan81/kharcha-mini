// Second-pass repair driven by audit2-findings-*.json (post-repair audit of
// every live row). Usage: bun scripts/repair2.ts (--dry-run | --apply) <findings-dir>
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";

const mode = process.argv[2];
const dir = process.argv[3];
if ((mode !== "--dry-run" && mode !== "--apply") || !dir) {
  console.error("usage: bun scripts/repair2.ts (--dry-run | --apply) <findings-dir>");
  process.exit(1);
}
const apply = mode === "--apply";
const dbPath = `${process.env.HOME}/Desktop/code/kharcha-mini/data/kharcha-mini.db`;
// Keep in sync with FALLBACK_FX_RATES in src/ingest/openrouter.ts.
const FX_RATES: Record<string, number> = {
  USD: 102,
  EUR: 110,
  GBP: 129,
  AED: 28,
  SGD: 76,
  AUD: 66,
  CAD: 73,
};

interface Finding {
  id: number;
  issues: string[];
  detail: string;
  suggest?: {
    is_transaction?: boolean;
    merchant?: string;
    category?: string;
    type?: string;
    amount?: number;
    currency?: string;
    date?: string;
  };
}

const merged = new Map<number, Finding>();
for (const f of readdirSync(dir).filter((f) => /^audit2-findings-\d+\.json$/.test(f))) {
  const data = JSON.parse(await Bun.file(`${dir}/${f}`).text()) as {
    findings: Finding[];
  };
  for (const fin of data.findings) {
    const prev = merged.get(fin.id);
    if (!prev) merged.set(fin.id, { ...fin, issues: [...fin.issues], suggest: { ...fin.suggest } });
    else {
      for (const c of fin.issues) if (!prev.issues.includes(c)) prev.issues.push(c);
      prev.suggest = { ...prev.suggest, ...fin.suggest };
    }
  }
}
console.log(`merged findings for ${merged.size} rows`);

const db = new Database(dbPath);
const getRow = db.prepare(
  "SELECT id, type, amount, merchant, category, date, parsed_by, currency, deleted_at FROM transactions WHERE id = ?",
);
const counts: Record<string, number> = {};
const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
const changes: string[] = [];
const updates = new Map<number, Record<string, unknown>>();
const tombstones = new Set<number>();
const set = (id: number, k: string, v: unknown) => {
  const u = updates.get(id) ?? {};
  u[k] = v;
  updates.set(id, u);
};

for (const [id, f] of merged) {
  const row = getRow.get(id) as {
    id: number; type: string; amount: number; merchant: string;
    category: string | null; date: string; parsed_by: string;
    currency: string | null; deleted_at: string | null;
  } | null;
  if (!row || row.deleted_at) {
    bump(row ? "already_tombstoned" : "missing_row");
    continue;
  }
  const s = f.suggest ?? {};
  const codes = f.issues.join(",");

  if (f.issues.includes("NOT_A_TRANSACTION")) {
    tombstones.add(id);
    changes.push(`${id}\ttombstone\t${codes}\t${f.detail.slice(0, 80)}`);
    bump("tombstone");
    continue;
  }
  if (f.issues.includes("WRONG_DATE") && s.date && /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(s.date)) {
    set(id, "date", s.date);
    changes.push(`${id}\tdate\t${row.date} -> ${s.date}`);
    bump("date");
  }
  if (f.issues.includes("WRONG_CURRENCY") && s.currency && s.amount != null && !row.currency) {
    const rate = FX_RATES[s.currency];
    if (!rate) {
      bump("currency_unknown_rate");
      changes.push(`${id}\tcurrency-skip\tno FX rate for ${s.currency}`);
      continue;
    }
    const inr = Math.round(s.amount * rate * 100) / 100;
    set(id, "currency", s.currency);
    set(id, "original_amount", s.amount);
    set(id, "amount", inr);
    set(id, "needs_review", 1);
    changes.push(`${id}\tcurrency\t${row.amount} -> ${s.currency} ${s.amount} (INR ${inr})`);
    bump("currency");
  }
  if (f.issues.includes("WRONG_TYPE") && s.type && ["income", "expense", "investment"].includes(s.type)) {
    set(id, "type", s.type);
    changes.push(`${id}\ttype\t${row.type} -> ${s.type}`);
    bump("type");
  }
  if (f.issues.includes("WRONG_AMOUNT") && s.amount != null && !f.issues.includes("WRONG_CURRENCY")) {
    set(id, "amount", s.amount);
    if (row.parsed_by === "failed") {
      set(id, "parsed_by", "openrouter");
      set(id, "confidence", "medium");
      if (s.type) set(id, "type", s.type);
      if (s.merchant) set(id, "merchant", s.merchant);
      if (s.date) set(id, "date", s.date);
    }
    changes.push(`${id}\tamount\t${row.amount} -> ${s.amount}`);
    bump("amount");
  }
  if (f.issues.includes("WRONG_MERCHANT") && s.merchant) {
    set(id, "merchant", s.merchant);
    set(id, "merchant_canonical", s.merchant);
    changes.push(`${id}\tmerchant\t${row.merchant} -> ${s.merchant}`);
    bump("merchant");
  }
  if (f.issues.includes("WRONG_CATEGORY") && s.category) {
    set(id, "category", s.category);
    changes.push(`${id}\tcategory\t${row.category} -> ${s.category}`);
    bump("category");
  }
}
for (const id of tombstones) updates.delete(id);

if (!apply) {
  await Bun.write(`${dir}/repair2-report.tsv`, changes.join("\n") + "\n");
  console.log(`dry-run: ${changes.length} changes -> ${dir}/repair2-report.tsv`);
} else {
  db.exec("BEGIN");
  for (const id of tombstones) {
    db.exec(`UPDATE transactions SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ${id}`);
  }
  const allowed = new Set(["date", "amount", "type", "merchant", "merchant_canonical", "category", "currency", "original_amount", "needs_review", "parsed_by", "confidence"]);
  for (const [id, u] of updates) {
    const fields = Object.keys(u).filter((k) => allowed.has(k));
    if (!fields.length) continue;
    db.prepare(
      `UPDATE transactions SET ${fields.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`,
    ).run(...fields.map((k) => u[k] as string | number), id);
  }
  db.exec("COMMIT");
  console.log(`applied: ${tombstones.size} tombstones, ${updates.size} updated rows`);
  console.log(db.query("PRAGMA integrity_check").get());
}
console.log("summary:", JSON.stringify(counts, null, 1));
db.close();
