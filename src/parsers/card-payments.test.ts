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

describe("card cashback credits", () => {
  test("records an Axis cashback credit as income", () => {
    const outcome = parseMessage(
      "axis",
      "Congratulations! Cashback of INR 455 has been credited to your Axis Bank Flipkart Credit Card XX1111 towards your last month spends - Axis Bank",
    );
    expect(outcome.parsedBy).toBe("regex");
    expect(outcome.parsed).toMatchObject({
      amount: 455,
      merchant: "Axis Flipkart Card Cashback",
      category: "Refunds",
      type: "income",
      accountLast4: "1111",
    });
  });
});

describe("Axis NEFT salary credit", () => {
  test("records an Axis NEFT credit with new format as income", () => {
    const body =
      "INR 250000.00 credited to Axis Bank A/c XX1234 on 30-09-26 at 13:07:01 IST. Ref: NEFT/CMS123456789/HACK.View bal: https://ccm.axis.bank.in/AXISBK/xxxx";
    const outcome = parseMessage("axis", body);

    expect(outcome.parsedBy).toBe("regex");
    expect(outcome.parsed).toMatchObject({
      amount: 250000,
      merchant: "HACK",
      date: "2026-09-30 13:07",
      type: "income",
      referenceNumber: "CMS123456789",
      accountLast4: "1234",
    });
  });
});

describe("HDFC refunds and reversals", () => {
  test("records an HDFC card reversal as income refund", () => {
    const body =
      "Transaction Reversed!On HDFC Bank CREDIT Card xx1111 Amt: Rs.49.76 By MODAL.COM On 2026-08-25:18:00:46";
    const outcome = parseMessage("hdfc", body);

    expect(outcome.parsedBy).toBe("regex");
    expect(outcome.parsed).toMatchObject({
      amount: 49.76,
      merchant: "MODAL.COM",
      category: "Refunds",
      date: "2026-08-25 18:00",
      type: "income",
      accountLast4: "1111",
    });
  });

  test("records an HDFC card refund as income refund", () => {
    const body =
      "Alert! Rs. 162 refunded by PAY*SWIGGY FOOD        BANGALORE     KAR on 29/AUG/2026 & adjusted against HDFC Bank Credit Card 1111 View updated balance here: https://...";
    const outcome = parseMessage("hdfc", body);

    expect(outcome.parsedBy).toBe("regex");
    expect(outcome.parsed).toMatchObject({
      amount: 162,
      merchant: "PAY*SWIGGY FOOD BANGALORE KAR",
      category: "Refunds",
      date: "2026-08-29 00:00",
      type: "income",
      accountLast4: "1111",
    });
  });
});

describe("non-transaction notice guards", () => {
  test("skips HDFC AutoPay (E-mandate) debit alert", () => {
    const body =
      "AutoPay (E-mandate) Success! For ExampleCo.. Txn Amt:INR599.19 Dt:02/09/2026 Via:HDFC Bank CC 1111 Mandate ID: MANDATE01 Not You? To Block+Reissue Call 18000000000/SMS BLOCK CC 1111 to 919876543210";
    const outcome = parseMessage("hdfc", body);

    expect(outcome.parsedBy).toBe("failed");
    expect(outcome.parsed).toBeNull();
  });

  test("skips HDFC payment pending reminder", () => {
    const body =
      "Alert! Payment pending of Rs 2700 for your HDFC Bank Credit Card 1111. Pay now: https://... Ignore if paid";
    const outcome = parseMessage("hdfc", body);

    expect(outcome.parsedBy).toBe("failed");
    expect(outcome.parsed).toBeNull();
  });

  test("skips Standing Instruction declined notice", () => {
    const body =
      "Standing Instruction declined for INR 500 on your HDFC Bank Credit Card ending 1111";
    const outcome = parseMessage("hdfc", body);

    expect(outcome.parsedBy).toBe("failed");
    expect(outcome.parsed).toBeNull();
  });
});
