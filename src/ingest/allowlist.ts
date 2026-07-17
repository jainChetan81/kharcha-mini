import { eq } from "drizzle-orm";
import { db } from "../db/connection";
import { senderAllowlist } from "../db/schema";

export interface AllowlistEntry {
  bankCode: string;
  bankName: string | null;
  parserKey: string | null;
}

export async function getActiveAllowlist(): Promise<AllowlistEntry[]> {
  const rows = await db
    .select({
      bankCode: senderAllowlist.bankCode,
      bankName: senderAllowlist.bankName,
      parserKey: senderAllowlist.parserKey,
    })
    .from(senderAllowlist)
    .where(eq(senderAllowlist.isActive, 1))
    .all();
  return rows;
}

export async function getActiveBankCodes(): Promise<string[]> {
  const rows = await db
    .select({ bankCode: senderAllowlist.bankCode })
    .from(senderAllowlist)
    .where(eq(senderAllowlist.isActive, 1))
    .all();
  return rows.map((r) => r.bankCode);
}

export async function upsertAllowlistEntry(
  bankCode: string,
  bankName: string | null = null,
  parserKey: string | null = null,
  isActive = true,
): Promise<void> {
  await db
    .insert(senderAllowlist)
    .values({
      bankCode: bankCode.toUpperCase(),
      bankName,
      parserKey,
      isActive: isActive ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: senderAllowlist.bankCode,
      set: {
        bankName,
        parserKey,
        isActive: isActive ? 1 : 0,
      },
    });
}

export async function deactivateBankCode(bankCode: string): Promise<void> {
  await db
    .update(senderAllowlist)
    .set({ isActive: 0 })
    .where(eq(senderAllowlist.bankCode, bankCode.toUpperCase()));
}

/**
 * Find the first active allowlist entry whose core bank code is a substring of
 * the raw chat.db sender id. Real forwarded SMS sender ids have carrier/relay
 * variants (e.g. 'AX-AXISBK-S', 'AXISBK-S(smsft_fi)') that all contain the
 * literal bank code ('AXISBK').
 */
export async function findByRawSenderId(
  rawSenderId: string,
): Promise<AllowlistEntry | null> {
  const active = await getActiveAllowlist();
  const normalized = rawSenderId.toUpperCase();
  const entry = active.find((e) => normalized.includes(e.bankCode));
  return entry ?? null;
}
