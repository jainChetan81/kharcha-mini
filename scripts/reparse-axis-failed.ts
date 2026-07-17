import { createHash } from "node:crypto";
import { copyFileSync } from "node:fs";
import { sqlite } from "../src/db/connection";
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

interface FailedRow {
  id: number;
  source_message_guid: string;
  raw_text: string;
  sender_id: string;
  date: string;
}

const DB_PATH = sqlite.filename;
const backupPath = `${DB_PATH}.reparse-backup-${Date.now()}`;
console.log(`backing up db to ${backupPath}`);
copyFileSync(DB_PATH, backupPath);

const rows = sqlite
  .query<FailedRow, []>(
    `SELECT id, source_message_guid, raw_text, sender_id, date FROM transactions WHERE bank_name = 'Axis Bank' AND parsed_by = 'failed'`,
  )
  .all();

console.log(`found ${rows.length} failed Axis rows to re-parse`);

let improved = 0;
let unchanged = 0;
let errors = 0;

const update = sqlite.prepare(
  `UPDATE transactions
   SET type = ?, amount = ?, merchant = ?, category = ?, date = ?,
       parsed_by = ?, parser_key = ?, bank_name = ?, confidence = ?,
       reference_number = ?, account_last4 = ?, fingerprint = ?, sync_status = 'pending'
   WHERE id = ?`,
);

sqlite.transaction(() => {
  for (const row of rows) {
    try {
      // Some historic rows were decoded with a leading 0x00/0x01 streamtyped
      // type marker that SQLite treats as a string terminator. Strip it before
      // re-parsing so these rows get a fair shot.
      const cleanedRawText = row.raw_text.replace(/^[\x00\x01]+/, "");
      const outcome = parseMessage("axis", cleanedRawText);
      if (outcome.parsedBy !== "regex" || !outcome.parsed) {
        unchanged++;
        continue;
      }

      const parsed = outcome.parsed;
      const amount = parsed.amount ?? 0;
      const merchant = parsed.merchant ?? "Unknown";
      const type = parsed.type ?? "expense";
      const dateText = parsed.date ?? row.date;
      const referenceNumber = parsed.referenceNumber ?? null;
      const accountLast4 = parsed.accountLast4 ?? null;

      // Recompute fingerprint from the newly parsed canonical fields. Keep the
      // original message date as the timestamp anchor.
      const parsedDate = parsed.date ? new Date(parsed.date.replace(" ", "T")) : new Date(row.date.replace(" ", "T"));
      const fingerprint = computeFingerprint(
        row.sender_id,
        amount,
        parsedDate,
        referenceNumber,
      );

      update.run(
        type,
        amount,
        merchant,
        parsed.category ?? "Other",
        dateText,
        outcome.parsedBy,
        outcome.parserKey,
        outcome.bankName,
        parsed.confidence ?? "medium",
        referenceNumber,
        accountLast4,
        fingerprint,
        row.id,
      );
      improved++;
    } catch (err) {
      errors++;
      console.error(
        `error re-parsing ${row.source_message_guid}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
})();

console.log(`re-parse complete: improved=${improved}, unchanged=${unchanged}, errors=${errors}`);
