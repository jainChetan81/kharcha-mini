import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, startOfDay } from "date-fns";
import { eq } from "drizzle-orm";
import { ensureSchema } from "../db/bootstrap";
import { db } from "../db/connection";
import { transactions, merchantAliases } from "../db/schema";
import { startServer } from "../api/server";
import { DATE_TIME_FORMAT } from "../parsers/utils";

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
  const tmpDir = mkdtempSync(join(tmpdir(), "kharcha-mini-verify-api-"));
  const dbPath = join(tmpDir, "test.db");
  process.env.KHARCHA_MINI_DB = dbPath;

  // The /digest/today assertions below only hold if the seeded transactions
  // land on the current date, so derive it instead of hardcoding one.
  const todayDate = format(new Date(), "yyyy-MM-dd");

  try {
    ensureSchema();

    // Start the API on an ephemeral port.
    const server = startServer({ port: 0, hostname: "127.0.0.1" });
    const url = `http://${server.hostname}:${server.port}`;

    try {
      // 1. /health without auth succeeds.
      const health = await fetch(`${url}/health`);
      assert(health.status === 200, `expected /health 200, got ${health.status}`);
      const healthBody = (await health.json()) as { ok: boolean };
      assert(healthBody.ok === true, "expected /health ok=true");
      // eslint-disable-next-line no-console
      console.log("OK: /health without auth succeeds");

      // 2. No auth anywhere: a stray Authorization header is ignored, not rejected.
      const strayAuth = await fetch(`${url}/transactions`, {
        headers: { Authorization: "Bearer whatever" },
      });
      assert(
        strayAuth.status === 200,
        `expected 200 with stray auth header, got ${strayAuth.status}`,
      );
      // eslint-disable-next-line no-console
      console.log("OK: Authorization header is ignored, never 401");

      // 3. /transactions succeeds without any headers and is empty initially.
      const emptyList = await fetch(`${url}/transactions`);
      assert(emptyList.status === 200, `expected 200, got ${emptyList.status}`);
      const emptyBody = (await emptyList.json()) as { transactions: unknown[] };
      assert(Array.isArray(emptyBody.transactions), "expected transactions array");
      assert(emptyBody.transactions.length === 0, "expected empty transactions list");
      // eslint-disable-next-line no-console
      console.log("OK: GET /transactions succeeds with no headers");

      // 4. POST /transactions round-trips.
      const createRes = await fetch(`${url}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "expense",
          amount: 250.5,
          merchant: "Coffee Shop",
          category: "Food",
          date: `${todayDate} 09:30`,
        }),
      });
      assert(createRes.status === 201, `expected 201, got ${createRes.status}`);
      const createBody = (await createRes.json()) as { transaction: { id: number } };
      assert(typeof createBody.transaction.id === "number", "expected created transaction id");
      // eslint-disable-next-line no-console
      console.log("OK: POST /transactions creates a transaction");

      const listRes = await fetch(
        `${url}/transactions?since=${createBody.transaction.id - 1}`,
      );
      assert(listRes.status === 200, `expected 200, got ${listRes.status}`);
      const listBody = (await listRes.json()) as { transactions: Array<{ id: number; merchant: string; amount: number }> };
      assert(listBody.transactions.length >= 1, "expected at least one transaction");
      assert(
        listBody.transactions.some((t) => t.merchant === "Coffee Shop" && t.amount === 250.5),
        "expected created transaction in list",
      );
      // eslint-disable-next-line no-console
      console.log("OK: GET /transactions?since= round-trips created transaction");

      // 5. PATCH /transactions/:id updates and writes a manual alias.
      const patchRes = await fetch(`${url}/transactions/${createBody.transaction.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant: "Blue Tokai",
          category: "Beverages",
        }),
      });
      assert(patchRes.status === 200, `expected 200, got ${patchRes.status}`);
      const patchBody = (await patchRes.json()) as { transaction: { merchant: string; category: string } };
      assert(patchBody.transaction.merchant === "Blue Tokai", "expected patched merchant");
      assert(patchBody.transaction.category === "Beverages", "expected patched category");

      const alias = await db
        .select()
        .from(merchantAliases)
        .where(eq(merchantAliases.rawPattern, "COFFEE SHOP"))
        .get();
      assert(alias !== undefined, "expected manual alias for original merchant");
      assert(alias.canonicalMerchant === "Blue Tokai", "expected alias canonical merchant");
      assert(alias.source === "manual", "expected alias source=manual");
      // eslint-disable-next-line no-console
      console.log("OK: PATCH /transactions/:id updates and writes manual alias");

      // 6. /digest/today returns sane shape against seeded data.
      const todayStart = format(startOfDay(new Date()), DATE_TIME_FORMAT);
      await db.insert(transactions).values({
        type: "expense",
        amount: 999,
        merchant: "Failed Merchant",
        category: "Other",
        date: todayStart,
        rawText: "failed sms",
        senderId: "unknown",
        parsedBy: "failed",
        confidence: "low",
        fingerprint: "seed-failed-1",
        sourceMessageGuid: "seed-failed-1",
        syncStatus: "pending",
      });

      const digestRes = await fetch(`${url}/digest/today`);
      assert(digestRes.status === 200, `expected 200, got ${digestRes.status}`);
      const digestBody = (await digestRes.json()) as {
        transactionCount: number;
        totalSpend: number;
        reviewCount: number;
        since: string;
      };
      assert(typeof digestBody.transactionCount === "number", "expected transactionCount number");
      assert(typeof digestBody.totalSpend === "number", "expected totalSpend number");
      assert(typeof digestBody.reviewCount === "number", "expected reviewCount number");
      assert(digestBody.transactionCount >= 2, "expected at least 2 transactions today");
      assert(digestBody.totalSpend >= 1249.5, `expected totalSpend >= 1249.5, got ${digestBody.totalSpend}`);
      assert(digestBody.reviewCount >= 1, "expected at least 1 review item");
      assert(typeof digestBody.since === "string", "expected since string");
      // eslint-disable-next-line no-console
      console.log("OK: /digest/today returns sane shape");

      // 7. Sync status shape.
      const syncRes = await fetch(`${url}/sync/status`);
      assert(syncRes.status === 200, `expected 200, got ${syncRes.status}`);
      const syncBody = (await syncRes.json()) as {
        cursor: string;
        lastPollAt: string | null;
        addedSinceLastCheck: number;
      };
      assert(typeof syncBody.cursor === "string", "expected cursor string");
      assert(typeof syncBody.addedSinceLastCheck === "number", "expected addedSinceLastCheck number");
      // eslint-disable-next-line no-console
      console.log("OK: /sync/status returns sane shape");

      // eslint-disable-next-line no-console
      console.log("\nAll API verification checks passed.");
    } finally {
      server.stop(true);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("verify-api failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
