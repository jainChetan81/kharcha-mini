import { describe, expect, test } from "bun:test";
import { pairsWithAchDebit, type SipRow } from "./sip";

const liveAch = (): SipRow => ({ isAchDr: true, deletedAt: null });
const goneAch = (): SipRow => ({ isAchDr: true, deletedAt: "2026-08-18 09:00:00" });
const liveNach = (): SipRow => ({ isAchDr: false, deletedAt: null });
const goneNach = (): SipRow => ({ isAchDr: false, deletedAt: "2026-08-18 09:00:00" });

describe("pairsWithAchDebit", () => {
  test("a NACH notice after a live ACH-DR debit pairs as a tombstone", () => {
    expect(pairsWithAchDebit([liveAch()])).toBe(true);
  });

  test("a NACH notice with no ACH-DR debit stays live", () => {
    expect(pairsWithAchDebit([])).toBe(false);
  });

  test("an already-paired ACH-DR debit pairs only once", () => {
    expect(pairsWithAchDebit([liveAch(), goneNach()])).toBe(false);
  });

  test("a second ACH-DR debit pairs a second NACH notice", () => {
    expect(pairsWithAchDebit([liveAch(), liveAch(), goneNach()])).toBe(true);
  });

  test("existing live NACH notices do not consume ACH-DR debit pairing", () => {
    expect(pairsWithAchDebit([liveAch(), liveNach()])).toBe(true);
  });
});
