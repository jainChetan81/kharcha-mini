import { eq, sql } from "drizzle-orm";
import { db } from "./connection";
import { merchantAliases } from "./schema";

/**
 * Normalize a merchant string for exact-match alias lookups.
 * - UPPERCASE
 * - strip punctuation (anything that is not a letter, digit, or whitespace)
 * - collapse whitespace
 * - strip trailing numeric transaction codes (6+ digits)
 * - strip trailing reference/txn keywords + their codes
 */
export function normalizeMerchant(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+\d{6,}$/, "")
    .replace(
      /\s+(?:REF|RRN|UTR|TXN|TRANSACTION|ID|NO|NUMBER)\s*[A-Z0-9]+$/i,
      "",
    )
    .trim();
}

export interface AliasMatch {
  id: number;
  rawPattern: string;
  canonicalMerchant: string;
  category: string | null;
  source: "auto" | "manual";
  hitCount: number;
}

export async function findAlias(
  rawMerchant: string,
): Promise<AliasMatch | null> {
  const pattern = normalizeMerchant(rawMerchant);
  if (!pattern) return null;

  const row = await db
    .select({
      id: merchantAliases.id,
      rawPattern: merchantAliases.rawPattern,
      canonicalMerchant: merchantAliases.canonicalMerchant,
      category: merchantAliases.category,
      source: merchantAliases.source,
      hitCount: merchantAliases.hitCount,
    })
    .from(merchantAliases)
    .where(eq(merchantAliases.rawPattern, pattern))
    .get();

  return row ?? null;
}

export async function incrementHitCount(id: number): Promise<void> {
  await db
    .update(merchantAliases)
    .set({
      hitCount: sql`${merchantAliases.hitCount} + 1`,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(merchantAliases.id, id));
}

export async function upsertAlias(params: {
  rawMerchant: string;
  canonicalMerchant: string;
  category?: string | null;
  source: "auto" | "manual";
}): Promise<void> {
  const pattern = normalizeMerchant(params.rawMerchant);
  if (!pattern) return;

  await db
    .insert(merchantAliases)
    .values({
      rawPattern: pattern,
      canonicalMerchant: params.canonicalMerchant,
      category: params.category ?? null,
      source: params.source,
      hitCount: 1,
    })
    .onConflictDoUpdate({
      target: merchantAliases.rawPattern,
      set: {
        canonicalMerchant: params.canonicalMerchant,
        category: params.category ?? null,
        source: params.source,
        updatedAt: sql`(datetime('now'))`,
      },
    });
}
