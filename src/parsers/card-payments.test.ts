import { describe, expect, test } from "bun:test";
import { parseMessage } from "./index";

describe("credit-card payment receipts", () => {
  test("keeps an Axis card payment as a categorised expense", () => {
    const body =
      "Payment of INR 99826.95 has been received towards your Axis Bank Credit Card XX3266 on 11-08-26 - Axis Bank";
    const outcome = parseMessage("axis", body);

    expect(outcome.parsedBy).toBe("regex");
    expect(outcome.parsed).toMatchObject({
      amount: 99826.95,
      merchant: "Axis Credit Card",
      category: "Credit Card Payment",
      date: "2026-08-11 00:00",
      type: "expense",
      accountLast4: "3266",
    });
  });

  test("keeps an HDFC card payment as a categorised expense", () => {
    const body =
      "DEAR HDFCBANK CARDMEMBER, PAYMENT OF Rs. 19209.00 RECEIVED TOWARDS YOUR CREDIT CARD ENDING WITH 2047 ON 11-8-2026.YOUR AVAILABLE LIMIT IS RS. 88591.0";
    const outcome = parseMessage("hdfc", body);

    expect(outcome.parsedBy).toBe("regex");
    expect(outcome.parsed).toMatchObject({
      amount: 19209,
      merchant: "HDFC Credit Card",
      category: "Credit Card Payment",
      date: "2026-08-11 00:00",
      type: "expense",
      accountLast4: "2047",
    });
  });

  test("categorises a CRED bank debit as a card payment", () => {
    const body =
      "INR 99826.95 debited\nA/c no. XX0532\n11-08-26, 19:16:00\nUPI/P2M/857256705289/CRED Club\nNot you? SMS BLOCKUPI";
    const outcome = parseMessage("axis", body);

    expect(outcome.parsedBy).toBe("regex");
    expect(outcome.parsed).toMatchObject({
      amount: 99826.95,
      merchant: "CRED Club",
      category: "Credit Card Payment",
      type: "expense",
    });
  });

  test("categorises CRED on the Amount Debited layout", () => {
    const body =
      "Amount Debited: INR 5000.00\nAccount Number: XX0532\nDate & Time: 11-08-26, 19:16:00 IST\nTransaction Info: UPI/P2M/857256705289/CRED Club";
    const outcome = parseMessage("axis", body);
    expect(outcome.parsed).toMatchObject({ amount: 5000, merchant: "CRED Club", category: "Credit Card Payment" });
  });

  test("CRED Pay purchases stay ordinary spend", () => {
    const body =
      "INR 250.00 debited\nA/c no. XX0532\n11-08-26, 19:16:00\nUPI/P2M/857256705289/CRED Pay\nNot you? SMS BLOCKUPI";
    const outcome = parseMessage("axis", body);
    expect(outcome.parsed?.merchant).toBe("CRED Pay");
    expect(outcome.parsed?.category).toBeUndefined();
  });

  test("keeps an HDFC online card payment acknowledgement", () => {
    const body =
      "HDFC Bank Cardmember, Online Payment of Rs.19209 vide Ref# 2231916484kfVDx was credited to your card ending 2047 On 12/AUG/2026_value Date 11/AUG/2026";
    const outcome = parseMessage("hdfc", body);

    expect(outcome.parsedBy).toBe("regex");
    expect(outcome.parsed).toMatchObject({
      amount: 19209,
      merchant: "HDFC Credit Card",
      category: "Credit Card Payment",
      date: "2026-08-11 00:00",
      type: "expense",
      referenceNumber: "2231916484KFVDX",
      accountLast4: "2047",
    });
  });

  test("keeps a pending-balance reminder out of the ledger", () => {
    const body =
      "We appreciate the recent payment towards your Credit Card ending with XX2047. Rs.4216 remains pending.";
    const outcome = parseMessage("hdfc", body);

    expect(outcome.parsedBy).toBe("failed");
    expect(outcome.parsed).toBeNull();
  });
});
