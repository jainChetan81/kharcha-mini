import { createHash } from "node:crypto";
import { copyFileSync } from "node:fs";
import { sqlite } from "../src/db/connection";
import { extractAttributedBodyText, openChatDb } from "../src/ingest/chatdb-reader";
import { parseMessage } from "../src/parsers";

function dateToMinute(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function computeFingerprint(
  senderId: string,
  amount: number,
  date: Date,
  referenceNumber: string | null | undefined,
): string {
  const dateKey = dateToMinute(date);
  const payload = referenceNumber
    ? `${referenceNumber}|${amount}|${dateKey}`
    : `${senderId}|${amount}|${dateKey}`;
  return createHash("sha256").update(payload).digest("hex");
}

interface AffectedRow {
  id: number;
  source_message_guid: string;
  sender_id: string;
  bank_name: string | null;
  parser_key: string | null;
  date: string;
  parsed_by: "regex" | "openrouter" | "failed";
}

const DB_PATH = sqlite.filename;
const backupPath = `${DB_PATH}.reparse-backup-${Date.now()}`;
console.log(`backing up db to ${backupPath}`);
copyFileSync(DB_PATH, backupPath);

function printGroupedCounts(label: string): void {
  console.log(`\n--- ${label} ---`);
  const rows = sqlite
    .query<
      { parsed_by: string; bank_name: string | null; c: number },
      []
    >(
      `SELECT parsed_by, bank_name, COUNT(*) AS c
       FROM transactions
       GROUP BY parsed_by, bank_name
       ORDER BY bank_name, parsed_by`,
    )
    .all();
  for (const r of rows) {
    console.log(`  ${r.parsed_by} | ${r.bank_name ?? "null"}: ${r.c}`);
  }
  const total = sqlite.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM transactions`).get();
  console.log(`  total: ${total.c}`);
}

printGroupedCounts("BEFORE");

const affectedRows = sqlite
  .query<AffectedRow, []>(
    `SELECT id, source_message_guid, sender_id, bank_name, parser_key, date, parsed_by
     FROM transactions
     WHERE LENGTH(raw_text) = 0`,
  )
  .all();

console.log(`\nfound ${affectedRows.length} rows with LENGTH(raw_text) = 0`);

const byBank: Record<string, number> = {};
const byPreviousStatus: Record<string, number> = {};
for (const r of affectedRows) {
  byBank[r.bank_name ?? "null"] = (byBank[r.bank_name ?? "null"] ?? 0) + 1;
  byPreviousStatus[r.parsed_by] = (byPreviousStatus[r.parsed_by] ?? 0) + 1;
}
console.log("by bank:", byBank);
console.log("by previous parsed_by:", byPreviousStatus);

let rehydrated = 0;
let unchanged = 0;
let errors = 0;
let previouslyRegexNowFailed = 0;
const samples: Array<{
  id: number;
  guid: string;
  bank: string | null;
  previousStatus: string;
  newStatus: string;
  amount: number;
  merchant: string;
  date: string;
}> = [];

const chatDb = openChatDb();
try {
  const fetchStmt = chatDb.prepare<
    { attributedBody: Uint8Array | null },
    [string]
  >(`SELECT attributedBody FROM message WHERE guid = ?`);

  const updateStmt = sqlite.prepare(
    `UPDATE transactions
     SET raw_text = ?, type = ?, amount = ?, merchant = ?, category = ?, date = ?,
         parsed_by = ?, parser_key = ?, bank_name = ?, confidence = ?,
         reference_number = ?, account_last4 = ?, fingerprint = ?, sync_status = 'pending'
     WHERE id = ?`,
  );

  sqlite.transaction(() => {
    for (const row of affectedRows) {
      try {
        const msgRow = fetchStmt.get(row.source_message_guid);
        if (!msgRow?.attributedBody) {
          unchanged++;
          continue;
        }

        const decoded = extractAttributedBodyText(msgRow.attributedBody);
        if (!decoded || decoded.trim().length === 0) {
          unchanged++;
          continue;
        }

        const parserKey = row.parser_key;
        const outcome = parseMessage(parserKey, decoded);
        const parsed = outcome.parsed;

        if (outcome.parsedBy !== "regex" || !parsed) {
          // Recover the raw_text even when the parser still fails, so future
          // parser improvements can re-parse it. Keep parsed fields unchanged
          // for rows that were already regex-parsed to avoid regressions.
          sqlite
            .prepare(`UPDATE transactions SET raw_text = ?, sync_status = 'pending' WHERE id = ?`)
            .run(decoded, row.id);
          if (row.parsed_by === "regex") {
            previouslyRegexNowFailed++;
            samples.push({
              id: row.id,
              guid: row.source_message_guid,
              bank: row.bank_name,
              previousStatus: row.parsed_by,
              newStatus: outcome.parsedBy,
              amount: 0,
              merchant: "(raw_text recovered, parse failed)",
              date: row.date,
            });
          } else {
            unchanged++;
          }
          continue;
        }

        const amount = parsed.amount ?? 0;
        const merchant = parsed.merchant ?? "Unknown";
        const type = parsed.type ?? "expense";
        const dateText = parsed.date ?? row.date;
        const referenceNumber = parsed.referenceNumber ?? null;
        const accountLast4 = parsed.accountLast4 ?? null;
        const confidence = parsed.confidence ?? "medium";
        const category = parsed.category ?? "Other";
        const parsedDate = parsed.date
          ? new Date(parsed.date.replace(" ", "T"))
          : new Date(row.date.replace(" ", "T"));
        const fingerprint = computeFingerprint(
          row.sender_id,
          amount,
          parsedDate,
          referenceNumber,
        );

        updateStmt.run(
          decoded,
          type,
          amount,
          merchant,
          category,
          dateText,
          outcome.parsedBy,
          outcome.parserKey,
          outcome.bankName,
          confidence,
          referenceNumber,
          accountLast4,
          fingerprint,
          row.id,
        );

        rehydrated++;
        samples.push({
          id: row.id,
          guid: row.source_message_guid,
          bank: row.bank_name,
          previousStatus: row.parsed_by,
          newStatus: outcome.parsedBy,
          amount,
          merchant,
          date: dateText,
        });
      } catch (err) {
        errors++;
        console.error(
          `error rehydrating ${row.source_message_guid}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  })();
} finally {
  chatDb.close();
}

printGroupedCounts("AFTER");

console.log(
  `\nrehydration complete: rehydrated=${rehydrated}, unchanged=${unchanged}, errors=${errors}, previouslyRegexNowFailed=${previouslyRegexNowFailed}`,
);

console.log(`\nspot-check sample (${Math.min(samples.length, 10)} of ${samples.length} touched rows):`);
for (const s of samples.slice(0, 10)) {
  console.log(`  ${JSON.stringify(s)}`);
}

if (previouslyRegexNowFailed > 0) {
  console.warn(
    `\nWARNING: ${previouslyRegexNowFailed} previously regex-parsed rows could not be re-parsed after raw_text recovery.`,
  );
  process.exitCode = 2;
}
