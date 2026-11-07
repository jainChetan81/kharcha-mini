export interface SipRow {
  isAchDr: boolean;
  deletedAt: string | null;
}

export const isIndianClearing = (merchant: string): boolean =>
  /INDIAN\s+CLEARING/i.test(merchant);

export const isNachNotice = (rawText: string): boolean =>
  /NACH\s+debit/i.test(rawText);

export const isAchDrAlert = (rawText: string): boolean =>
  /ACH-DR/i.test(rawText);

/**
 * True when an incoming NACH notice should be stored as a tombstone because
 * an unpaired live ACH-DR INDIAN CLEARING row exists on the same date.
 * Each ACH-DR row pairs at most once and matches by count, not amount.
 */
export function pairsWithAchDebit(sameDayRows: SipRow[]): boolean {
  const liveAchCount = sameDayRows.filter((r) => r.isAchDr && !r.deletedAt).length;
  const pairedNachCount = sameDayRows.filter((r) => !r.isAchDr && r.deletedAt).length;
  return liveAchCount > pairedNachCount;
}
