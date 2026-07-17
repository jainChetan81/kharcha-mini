import { createHash, randomUUID } from "node:crypto";
import { format, startOfDay } from "date-fns";
import { and, count, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection";
import { ensureSchema } from "../db/bootstrap";
import { transactions, merchantAliases } from "../db/schema";
import { getConfig } from "../db/config";
import { normalizeMerchant, upsertAlias } from "../db/merchant-aliases";
import { readToken } from "./token";
import { DATE_TIME_FORMAT } from "../parsers/utils";

const DEFAULT_PORT = 8300;
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

const CURSOR_KEY = "chat_db_last_rowid";
const LAST_POLL_AT_KEY = "last_poll_at";

function log(...parts: unknown[]): void {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [api]`, ...parts);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function unauthorized(): Response {
  return json({ error: "Unauthorized" }, 401);
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

function notFound(message: string): Response {
  return json({ error: message }, 404);
}

function serverError(message: string): Response {
  return json({ error: message }, 500);
}

function isAuthenticated(req: Request): boolean {
  const header = req.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const token = readToken();
  if (!token) return false;
  return match[1] === token;
}

function requireAuth(req: Request): Response | null {
  if (!isAuthenticated(req)) return unauthorized();
  return null;
}

function parseSince(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (Number.isNaN(n) || n < 0) return null;
  return Math.floor(n);
}

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (Number.isNaN(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

const manualTransactionSchema = z.object({
  type: z.enum(["income", "expense", "investment"]),
  amount: z.number().positive(),
  merchant: z.string().min(1),
  category: z.string().min(1).optional(),
  date: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/,
      "date must be YYYY-MM-DD or YYYY-MM-DD HH:mm",
    ),
  rawText: z.string().min(1).optional(),
  senderId: z.string().min(1).optional(),
  bankName: z.string().optional(),
  referenceNumber: z.string().optional(),
  accountLast4: z.string().optional(),
});

function parseManualDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(raw)) {
    return raw.replace("T", " ").slice(0, 16);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw} 00:00`;
  }
  return format(new Date(), DATE_TIME_FORMAT);
}

function computeFingerprint(
  senderId: string,
  amount: number,
  date: string,
): string {
  const payload = `${senderId}|${amount}|${date}`;
  return createHash("sha256").update(payload).digest("hex");
}

async function getHealth(): Promise<Response> {
  const lastPollAt = await getConfig(LAST_POLL_AT_KEY);
  return json({ ok: true, lastPollAt });
}

async function listTransactions(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const since = parseSince(url.searchParams.get("since"));
  const limit = parseLimit(url.searchParams.get("limit"));

  // Tombstoned rows (OTP double-counts, AutoPay ghosts — see the 2026-07-17
  // repair pass) must never sync to the app.
  const conditions = [isNull(transactions.deletedAt)];
  if (since !== null) {
    conditions.push(gt(transactions.id, since));
  }
  const query = db
    .select()
    .from(transactions)
    .where(and(...conditions))
    .orderBy(transactions.id)
    .limit(limit);

  const rows = await query.all();
  return json({ transactions: rows });
}

async function createTransaction(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const parsed = manualTransactionSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const data = parsed.data;
  const date = parseManualDate(data.date);
  const senderId = data.senderId ?? "manual";
  const rawText = data.rawText ?? data.merchant;
  const category = data.category ?? "Other";
  const fingerprint = computeFingerprint(senderId, data.amount, date);
  const sourceMessageGuid = `manual-${randomUUID()}`;

  try {
    const result = await db
      .insert(transactions)
      .values({
        type: data.type,
        amount: data.amount,
        merchant: data.merchant,
        category,
        date,
        rawText,
        senderId,
        bankName: data.bankName ?? null,
        parserKey: null,
        parsedBy: "manual",
        confidence: "high",
        referenceNumber: data.referenceNumber ?? null,
        accountLast4: data.accountLast4 ?? null,
        fingerprint,
        sourceMessageGuid,
        syncStatus: "pending",
      })
      .returning()
      .get();

    return json({ transaction: result }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return serverError(`Insert failed: ${message}`);
  }
}

const patchTransactionSchema = z.object({
  merchant: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  amount: z.number().positive().optional(),
  date: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/,
      "date must be YYYY-MM-DD or YYYY-MM-DD HH:mm",
    )
    .optional(),
  type: z.enum(["income", "expense", "investment"]).optional(),
  referenceNumber: z.string().optional(),
  accountLast4: z.string().optional(),
});

async function updateTransaction(req: Request, id: string): Promise<Response> {
  const transactionId = Number(id);
  if (Number.isNaN(transactionId) || transactionId <= 0) {
    return badRequest("Invalid transaction id");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const parsed = patchTransactionSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const data = parsed.data;

  const existing = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .get();

  if (!existing) {
    return notFound("Transaction not found");
  }

  const updates: Partial<typeof transactions.$inferInsert> = {};

  if (data.merchant !== undefined) updates.merchant = data.merchant;
  if (data.category !== undefined) updates.category = data.category;
  if (data.amount !== undefined) updates.amount = data.amount;
  if (data.date !== undefined) updates.date = parseManualDate(data.date);
  if (data.type !== undefined) updates.type = data.type;
  if (data.referenceNumber !== undefined) {
    updates.referenceNumber = data.referenceNumber;
  }
  if (data.accountLast4 !== undefined) {
    updates.accountLast4 = data.accountLast4;
  }

  // When the merchant changes, write a manual alias so the corrected value
  // takes precedence over any auto alias.
  if (data.merchant !== undefined && data.merchant !== existing.merchant) {
    const rawPattern = normalizeMerchant(existing.merchant);
    if (rawPattern) {
      await upsertAlias({
        rawMerchant: existing.merchant,
        canonicalMerchant: data.merchant,
        category: data.category ?? existing.category,
        source: "manual",
      });
    }
  }

  try {
    const result = await db
      .update(transactions)
      .set({ ...updates, updatedAt: sql`(datetime('now'))` })
      .where(eq(transactions.id, transactionId))
      .returning()
      .get();
    return json({ transaction: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return serverError(`Update failed: ${message}`);
  }
}

async function getSyncStatus(): Promise<Response> {
  const cursor = await getConfig(CURSOR_KEY);
  const lastPollAt = await getConfig(LAST_POLL_AT_KEY);

  const pendingRow = await db
    .select({ count: count() })
    .from(transactions)
    .where(
      and(
        eq(transactions.syncStatus, "pending"),
        isNull(transactions.deletedAt),
      ),
    )
    .get();

  return json({
    cursor: cursor ?? "0",
    lastPollAt,
    addedSinceLastCheck: pendingRow?.count ?? 0,
  });
}

async function getDigestToday(): Promise<Response> {
  const todayStart = format(startOfDay(new Date()), DATE_TIME_FORMAT);

  const countRow = await db
    .select({ count: count() })
    .from(transactions)
    .where(
      and(gte(transactions.date, todayStart), isNull(transactions.deletedAt)),
    )
    .get();

  const spendRow = await db
    .select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(transactions)
    .where(
      and(
        eq(transactions.type, "expense"),
        gte(transactions.date, todayStart),
        isNull(transactions.deletedAt),
      ),
    )
    .get();

  const reviewRow = await db
    .select({ count: count() })
    .from(transactions)
    .where(
      and(
        eq(transactions.parsedBy, "failed"),
        isNull(transactions.deletedAt),
      ),
    )
    .get();

  const needsReviewRow = await db
    .select({ count: count() })
    .from(transactions)
    .where(
      and(eq(transactions.needsReview, 1), isNull(transactions.deletedAt)),
    )
    .get();

  return json({
    transactionCount: countRow?.count ?? 0,
    totalSpend: spendRow?.total ?? 0,
    reviewCount: reviewRow?.count ?? 0,
    needsReviewCount: needsReviewRow?.count ?? 0,
    since: todayStart,
  });
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const path = url.pathname;

  if (method === "GET" && path === "/health") {
    return getHealth();
  }

  const authError = requireAuth(req);
  if (authError) return authError;

  if (method === "GET" && path === "/transactions") {
    return listTransactions(req);
  }

  if (method === "POST" && path === "/transactions") {
    return createTransaction(req);
  }

  const patchMatch = path.match(/^\/transactions\/(\d+)$/);
  if (method === "PATCH" && patchMatch) {
    return updateTransaction(req, patchMatch[1]);
  }

  if (method === "GET" && path === "/sync/status") {
    return getSyncStatus();
  }

  if (method === "GET" && path === "/digest/today") {
    return getDigestToday();
  }

  return notFound("Not found");
}

export interface ServerOptions {
  port?: number;
  hostname?: string;
}

export function startServer(options: ServerOptions = {}) {
  ensureSchema();

  const port = options.port ?? DEFAULT_PORT;
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;

  if (hostname !== "127.0.0.1") {
    log("warning: binding to non-loopback address", hostname);
  }

  const server = Bun.serve({
    port,
    hostname,
    fetch: async (req) => {
      try {
        return await route(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError("unhandled route error:", message);
        return serverError("Internal server error");
      }
    },
  });

  log(`listening on http://${hostname}:${port}`);
  return server;
}

function logError(...parts: unknown[]): void {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.error(`[${ts}] [api]`, ...parts);
}

if (import.meta.main) {
  const token = readToken();
  if (!token) {
    logError(
      "bearer token not found in Keychain; generate it first (see runbook)",
    );
    process.exit(1);
  }
  startServer();
}
