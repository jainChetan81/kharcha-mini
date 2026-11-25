import { describe, expect, test } from "bun:test";
import { parseMessage } from "./index";

// Synthetic fixtures for the "Spent ... using Axis Bank Credit Card ... at
// {merchant}." layout. Before the 2026-11-25 fix these all parsed as the
// "Card Payment" placeholder.
const tail = "Avl limit: INR 61504.89. Not you? SMS BLOCK 1111 to +910000000000";
const cases = [
  ["INR 7918", "YATRA ONLIN", "YATRA ONLIN", undefined],
  ["INR 4590", "PAY*BLINKIT", "PAY*BLINKIT", undefined],
  ["INR 3", "Facebook In", "Facebook In", undefined],
  ["USD 17.7", "POLAR* C0DE", "POLAR* C0DE", "USD"],
  ["USD 19.99", "PADDLE*NET*", "PADDLE*NET*", "USD"],
  ["USD 12.74", "OPENROUTER,", "OPENROUTER", "USD"],
] as const;

describe("Axis card spend, 'using ... at merchant' layout", () => {
  for (const [amount, merchant, want, currency] of cases) {
    const layouts = {
      "multi-line": `Spent ${amount} \nusing Axis Bank Credit Card no. XX1111 on 06-11-26 18:19:44 IST at \n${merchant}. \n${tail}`,
      "one line": `Spent ${amount}  using Axis Bank Credit Card no. XX1111 on 06-11-26 18:19:44 IST at  ${merchant}.  ${tail}`,
    };
    for (const [name, sms] of Object.entries(layouts)) {
      test(`${merchant} (${name})`, () => {
        const outcome = parseMessage("axis", sms);
        expect(outcome.parsedBy).toBe("regex");
        expect(outcome.parsed).toMatchObject({
          amount: Number(amount.split(" ")[1]),
          merchant: want,
          date: "2026-11-06 18:19",
          type: "expense",
          accountLast4: "1111",
        });
        expect(outcome.parsed?.currency ?? undefined).toBe(currency);
      });
    }
  }

  test("the older layout still parses", () => {
    const outcome = parseMessage(
      "axis",
      "Spent INR 1215\nAxis Bank Card no. XX1111\n12-10-26 19:03:54 IST\nIBIBO GROUP\nAvl Limit: INR 70794.64",
    );
    expect(outcome.parsed?.merchant).toBe("IBIBO GROUP");
  });
});

describe("Axis UPI debit merchant names", () => {
  for (const [name, want] of [
    ["TEST SNACKS & TEA", "TEST SNACKS & TEA"],
    ["Test Hotel - IB.C", "Test Hotel - IB"],
    ["Test Beach Café", "Test Beach Café"],
    ["MPD-1 TEST ENT", "MPD-1 TEST ENT"],
  ] as const) {
    test(name, () => {
      const outcome = parseMessage(
        "axis",
        `INR 460.00 debited\nA/c no. XX2222\n10-11-26, 10:03:16\nUPI/P2M/700000000002/${name}\nNot you? SMS BLOCKUPI Cust ID to 919900000000`,
      );
      expect(outcome.parsed?.merchant).toBe(want);
      expect(outcome.parsed?.referenceNumber).toBe("700000000002");
    });
  }
});
