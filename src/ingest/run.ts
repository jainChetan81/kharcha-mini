import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { format } from "date-fns";
import { db } from "../db/connection";
import { transactions } from "../db/schema";
import { getConfig, setConfig } from "../db/config";
import { getActiveAllowlist, findByRawSenderId } from "./allowlist";
import { openChatDb, queryMessages, type ChatMessage } from "./chatdb-reader";
import { parseMessage, type ParseOutcome } from "../parsers";
import { DATE_TIME_FORMAT } from "../parsers/utils";
import { ensureSchema } from "../db/bootstrap";
import { resolveWithProofread } from "./proofread";

const BATCH_SIZE = 500;
const CURSOR_KEY = "chat_db_last_rowid";
const LAST_POLL_AT_KEY = "last_poll_at";
const KUMA_PUSH_SCRIPT = `${homedir()}/scripts/kuma_push.sh`;
const KUMA_MONITOR_NAME = "kharcha-mini-ingest";

function log(...parts: unknown[]): void {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}]`, ...parts);
}

function logError(...parts: unknown[]): void {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.error(`[${ts}]`, ...parts);
}

function dateToMinute(d: Date): string {
  return format(d, "yyyy-MM-dd HH:mm");
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

async function sendHeartbeat(): Promise<void> {
  // Fire-and-forget kuma heartbeat using the machine's standard push driver.
  try {
    const proc = Bun.spawn(["bash", KUMA_PUSH_SCRIPT, KUMA_MONITOR_NAME], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  } catch (err) {
    logError("heartbeat failed:", err instanceof Error ? err.message : err);
  }
}

async function upsertTransaction(
  msg: ChatMessage,
  outcome: ParseOutcome,
): Promise<void> {
  const allowlistEntry = msg.senderId
    ? await findByRawSenderId(msg.senderId)
    : null;
  const bankName = outcome.bankName ?? allowlistEntry?.bankName ?? null;
  const parserKey = outcome.parserKey ?? allowlistEntry?.parserKey ?? null;

  const parsed = outcome.parsed;
  const amount = parsed?.amount ?? 0;
  const merchant = parsed?.merchant ?? "Unknown";
  const type = parsed?.type ?? "expense";
  const dateText =
    parsed?.date ?? format(msg.date, DATE_TIME_FORMAT);
  const referenceNumber = parsed?.referenceNumber ?? null;
  const accountLast4 = parsed?.accountLast4 ?? null;
  const confidence = parsed?.confidence ?? "medium";

  const fingerprint = computeFingerprint(
    msg.senderId ?? "unknown",
    amount,
    msg.date,
    referenceNumber,
  );

  await db
    .insert(transactions)
    .values({
      type,
      amount,
      merchant,
      category: parsed?.category ?? "Other",
      date: dateText,
      rawText: msg.text,
      senderId: msg.senderId ?? "unknown",
      bankName,
      parserKey,
      parsedBy: outcome.parsedBy,
      confidence,
      referenceNumber,
      accountLast4,
      fingerprint,
      sourceMessageGuid: msg.guid,
      syncStatus: "pending",
    })
    .onConflictDoNothing({ target: transactions.sourceMessageGuid });
}

async function processBatch(
  cursor: number,
  bankCodes: string[],
): Promise<{ processed: number; nextCursor: number; errors: number }> {
  let chatDb;
  try {
    chatDb = openChatDb();
  } catch (err) {
    logError(
      "cannot open chat.db:",
      err instanceof Error ? err.message : err,
      "— grant Full Disk Access to /usr/local/bin/bun in System Settings → Privacy & Security → Full Disk Access",
    );
    return { processed: 0, nextCursor: cursor, errors: 0 };
  }

  let processed = 0;
  let errors = 0;
  let nextCursor = cursor;

  try {
    const messages = queryMessages(chatDb, {
      bankCodes,
      afterRowid: cursor,
      limit: BATCH_SIZE,
    });

    if (messages.length === 0) {
      log("no new messages after rowid", cursor);
      return { processed: 0, nextCursor: cursor, errors: 0 };
    }

    log(`fetched ${messages.length} message(s) after rowid ${cursor}`);

    for (const msg of messages) {
      try {
        if (!msg.senderId) continue;

        const allowlistEntry = await findByRawSenderId(msg.senderId);
        const parserKey = allowlistEntry?.parserKey ?? null;
        const bankName = allowlistEntry?.bankName ?? null;
        const initialOutcome = parseMessage(parserKey, msg.text);
        const outcome = await resolveWithProofread(
          msg.text,
          bankName,
          initialOutcome,
          msg.date,
        );

        await upsertTransaction(msg, outcome);

        // Cursor advances per successfully-committed row, not per batch.
        await setConfig(CURSOR_KEY, String(msg.rowid));
        nextCursor = msg.rowid;
        processed++;
      } catch (err) {
        errors++;
        logError(
          `failed to process rowid ${msg.rowid}:`,
          err instanceof Error ? err.message : err,
        );
        // Continue to the next message; never let one bad row block the cursor.
      }
    }
  } finally {
    chatDb.close();
  }

  return { processed, nextCursor, errors };
}

async function main(): Promise<void> {
  log("kharcha-mini ingest started");

  ensureSchema();

  const allowlist = await getActiveAllowlist();
  if (allowlist.length === 0) {
    log("sender allowlist is empty; nothing to poll. run: bun run seed:allowlist");
    await sendHeartbeat();
    return;
  }

  const bankCodes = allowlist.map((e) => e.bankCode);
  const cursor = Number((await getConfig(CURSOR_KEY)) ?? "0");

  const { processed, nextCursor, errors } = await processBatch(
    cursor,
    bankCodes,
  );

  log(
    `ingest finished: processed=${processed}, nextCursor=${nextCursor}, errors=${errors}`,
  );

  await setConfig(LAST_POLL_AT_KEY, new Date().toISOString());
  await sendHeartbeat();
}

main().catch((err) => {
  logError("ingest crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
