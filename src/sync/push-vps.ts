import { gt, asc } from "drizzle-orm";
import { db } from "../db/connection";
import { transactions } from "../db/schema";
import { getConfig, setConfig } from "../db/config";

const URL_KEY = "vps_push_url";
const TOKEN_KEY = "vps_push_token";
const CURSOR_KEY = "vps_push_last_id";
const BATCH_SIZE = 500;
const TIMEOUT_MS = 20_000;

function log(...parts: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

function logError(...parts: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error(`[${new Date().toISOString()}]`, ...parts);
}

/**
 * Push every transaction row newer than the stored cursor to the VPS
 * `kharcha-web` app. Never throws: a failed push leaves the cursor where it
 * was so the next run retries the same rows.
 */
export async function pushToVps(): Promise<void> {
  try {
    const url = (await getConfig(URL_KEY))?.trim().replace(/\/+$/, "");
    const token = (await getConfig(TOKEN_KEY))?.trim();
    if (!url || !token) {
      log("vps push skipped: not configured");
      return;
    }

    let cursor = Number((await getConfig(CURSOR_KEY)) ?? "0");
    if (!Number.isFinite(cursor)) cursor = 0;

    for (;;) {
      // ponytail: no other filter on purpose — tombstones and every
      // transaction type must reach the VPS unchanged.
      const rows = await db
        .select()
        .from(transactions)
        .where(gt(transactions.id, cursor))
        .orderBy(asc(transactions.id))
        .limit(BATCH_SIZE);

      if (rows.length === 0) return;

      const res = await fetch(`${url}/api/ingest`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transactions: rows }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        logError(
          `vps push failed: status=${res.status} body=${body.slice(0, 200)}`,
        );
        return;
      }

      cursor = rows[rows.length - 1].id;
      await setConfig(CURSOR_KEY, String(cursor));
      log(`vps push: sent ${rows.length} row(s), cursor=${cursor}`);
    }
  } catch (err) {
    logError("vps push error:", err instanceof Error ? err.message : err);
  }
}

if (import.meta.main) {
  await pushToVps();
}
