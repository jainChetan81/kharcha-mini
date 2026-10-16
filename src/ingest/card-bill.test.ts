import { describe, expect, test } from "bun:test";
import { pairsWithCardBill } from "./card-bill";

const live = (merchant: string) => ({ merchant, deletedAt: null });
const gone = (merchant: string) => ({ merchant, deletedAt: "2026-08-11T00:00:00Z" });

describe("pairsWithCardBill", () => {
  test("a receipt after its debit pairs", () => expect(pairsWithCardBill([live("CRED Club")], "Axis Credit Card")).toBe(true));
  test("two debits stay separate", () => expect(pairsWithCardBill([live("CRED Club")], "CRED Club")).toBe(false));
  test("two receipts stay separate", () => expect(pairsWithCardBill([live("Axis Credit Card")], "HDFC Credit Card")).toBe(false));
  test("a debit pairs once", () => expect(pairsWithCardBill([live("CRED Club"), gone("Axis Credit Card")], "HDFC Credit Card")).toBe(false));
  test("a second debit pairs a second receipt", () =>
    expect(pairsWithCardBill([live("CRED Club"), live("CRED Club"), gone("Axis Credit Card")], "HDFC Credit Card")).toBe(true));
});
