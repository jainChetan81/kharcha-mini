import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ensureSchema } from "../db/bootstrap";
import {
  findByRawSenderId,
  upsertAllowlistEntry,
} from "../ingest/allowlist";
import { queryMessages } from "../ingest/chatdb-reader";

function fail(message: string): never {
  // eslint-disable-next-line no-console
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

async function main(): Promise<void> {
  // Point at a temporary DB so the verification is isolated and repeatable.
  const tmpDir = mkdtempSync(join(tmpdir(), "kharcha-mini-verify-allowlist-"));
  const dbPath = join(tmpDir, "test.db");
  process.env.KHARCHA_MINI_DB = dbPath;

  try {
    ensureSchema();

    // Seed core bank codes.
    await upsertAllowlistEntry("AXISBK", "Axis Bank", "axis");
    await upsertAllowlistEntry("HDFCBK", "HDFC Bank", "hdfc");

    // 1. Substring matching via findByRawSenderId.
    const axisVariants = [
      "AXISBK-S(smsft_fi)",
      "AXISBK-S(smsft)",
      "AXISBK-S(smsft_rm)",
      "AXISBK-T(smsft)",
      "AX-AXISBK-S",
      "AD-AXISBK-S",
      "CP-AXISBK-S",
      "JX-AXISBK-S",
      "JK-AXISBK-S",
      "JD-AXISBK-S",
    ];
    for (const raw of axisVariants) {
      const entry = await findByRawSenderId(raw);
      assert(entry !== null, `expected match for ${raw}`);
      assert(entry.bankCode === "AXISBK", `expected AXISBK for ${raw}`);
      assert(entry.bankName === "Axis Bank", `expected Axis Bank for ${raw}`);
      assert(entry.parserKey === "axis", `expected axis parser for ${raw}`);
    }
    // eslint-disable-next-line no-console
    console.log("OK: AXISBK variants match via substring lookup");

    const hdfcVariants = [
      "HDFCBK-S(smsft)",
      "HDFCBK-S(smsft_fi)",
      "HDFCBK-S(smsft_rm)",
    ];
    for (const raw of hdfcVariants) {
      const entry = await findByRawSenderId(raw);
      assert(entry !== null, `expected match for ${raw}`);
      assert(entry.bankCode === "HDFCBK", `expected HDFCBK for ${raw}`);
    }
    // eslint-disable-next-line no-console
    console.log("OK: HDFCBK variants match via substring lookup");

    const unrelated = await findByRawSenderId("SWIGGY-S(smsft_or)");
    assert(unrelated === null, "SWIGGY should not match any bank entry");
    // eslint-disable-next-line no-console
    console.log("OK: unrelated sender does not match");

    // 2. SQL LIKE filter via queryMessages against a synthetic chat.db.
    const chatDbPath = join(tmpDir, "chat.db");
    const chatDb = new Database(chatDbPath, { create: true });
    chatDb.run(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        handle_id INTEGER,
        is_from_me INTEGER,
        service TEXT,
        text TEXT,
        attributedBody BLOB,
        date INTEGER
      );
    `);
    chatDb.run(
      `INSERT INTO handle (ROWID, id) VALUES (1, 'AX-AXISBK-S'), (2, 'HDFCBK-S(smsft_fi)'), (3, 'SWIGGY-S(smsft_or)');`,
    );
    chatDb.run(
      `INSERT INTO message (ROWID, guid, handle_id, is_from_me, service, text, date)
       VALUES (10, 'msg-axis-1', 1, 0, 'SMS', 'axis debit', 1),
              (20, 'msg-hdfc-1', 2, 0, 'SMS', 'hdfc debit', 2),
              (30, 'msg-swiggy-1', 3, 0, 'SMS', 'swiggy order', 3);`,
    );

    const found = queryMessages(chatDb, {
      bankCodes: ["AXISBK", "HDFCBK"],
      afterRowid: 0,
      limit: 100,
    });
    const foundSenderIds = found.map((m) => m.senderId).sort();
    assert(
      foundSenderIds.length === 2 &&
        foundSenderIds[0] === "AX-AXISBK-S" &&
        foundSenderIds[1] === "HDFCBK-S(smsft_fi)",
      `expected only bank messages, got ${JSON.stringify(foundSenderIds)}`,
    );
    // eslint-disable-next-line no-console
    console.log("OK: chat.db LIKE filter excludes unrelated senders");

    chatDb.close();

    // eslint-disable-next-line no-console
    console.log("\nAll allowlist verification checks passed.");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(
    "verify-allowlist failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
