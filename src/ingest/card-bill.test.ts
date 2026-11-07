import { describe, expect, test } from "bun:test";
import { isCardBillNotice, pairsWithCardBill } from "./card-bill";

const live = (merchant: string, rawText?: string) => ({ merchant, deletedAt: null, rawText });
const gone = (merchant: string, rawText?: string) => ({ merchant, deletedAt: "2026-08-11T00:00:00Z", rawText });

describe("pairsWithCardBill", () => {
  test("a receipt after its debit pairs", () => expect(pairsWithCardBill([live("CRED Club")], "Axis Credit Card")).toBe(true));
  test("two debits stay separate", () => expect(pairsWithCardBill([live("CRED Club")], "CRED Club")).toBe(false));
  test("two receipts stay separate", () => expect(pairsWithCardBill([live("Axis Credit Card")], "HDFC Credit Card")).toBe(false));
  test("a debit pairs once", () => expect(pairsWithCardBill([live("CRED Club"), gone("Axis Credit Card")], "HDFC Credit Card")).toBe(false));
  test("a second debit pairs a second receipt", () =>
    expect(pairsWithCardBill([live("CRED Club"), live("CRED Club"), gone("Axis Credit Card")], "HDFC Credit Card")).toBe(true));
  test("pairs an Axis auto-debit with an Axis card receipt", () => {
    const debitText =
      "Debit INR 15000.00\nAxis Bank A/c XX0000\n23-07-25 01:27:15\nCreditCard Payment XX 2222\nWhatsApp BAL to ...";
    const receiptText =
      "Payment of INR 15000.00 has been received towards your Axis Bank Credit Card XX2222 on 23-07-25 - Axis Bank";
    expect(
      pairsWithCardBill([live("Axis Credit Card", debitText)], "Axis Credit Card", receiptText),
    ).toBe(true);
  });
});

describe("isCardBillNotice", () => {
  test("bill and statement notices are kept", () => {
    expect(isCardBillNotice("Payment of INR 7162.88 for Axis Bank Credit Card no. XX1111 is due on 30-09-26 with minimum amount due of INR 144.")).toBe(true);
    expect(isCardBillNotice("Amount Due Rs.58752 on HDFC Bank Credit Card 1111. Pay instantly by 21/JUN/2026")).toBe(true);
    expect(isCardBillNotice("Statement Generated:\nFor HDFC Bank Credit Card XX1111.")).toBe(true);
  });
  test("OTPs and declines are not bills", () => {
    expect(isCardBillNotice("OTP is 123456 for txn of INR 310.00 at SHOP on HDFC Bank card ending 1111")).toBe(false);
  });
});
