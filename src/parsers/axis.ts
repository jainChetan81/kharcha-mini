import {
  extractAccountLast4,
  extractReferenceNumber,
  REFERENCE_PATTERNS,
  type Parser,
  parseAmount,
  parseAxisDate,
} from "./utils";

const BANK_NAME = "Axis Bank";
const PARSER_KEY = "axis";

/**
 * Axis sends a lot of notices that are not completed transactions: statements,
 * e-mandate registrations, upcoming AutoPay debits, OTPs, UPI PIN setup, etc.
 * Reject these outright so they never look like a transaction.
 */
function isAxisNonTransactionNotice(body: string): boolean {
  const lower = body.toLowerCase();

  // Statements are never transactions.
  if (/statement\s+(?:for\s+your\s+)?axis\s+bank\s+credit\s+card/i.test(body))
    return true;

  // E-mandate / upcoming / scheduled / conditional future debits.
  if (
    /(?:e-?mandate|upcoming\s+(?:mandate|debit|payment|transaction)|will\s+be\s+(?:debited|auto-?debited)|scheduled\s+(?:for|on)|shall\s+be\s+debited|on\s+approval[,.]?\s+INR\s+[\d,.]+\s+will\s+be\s+debited)/i.test(
      body,
    )
  ) {
    return true;
  }
  if (/\be-?mandate\b/i.test(body)) {
    const isPastTense = /(?:has\s+been|have\s+been|was|were)\s+(?:debited|charged)/i.test(
      body,
    );
    if (!isPastTense) return true;
  }

  // Mandate registration is a setup event, not a debit.
  if (/mandate\s+(?:for\s+.+?\s+)?has\s+been\s+registered/i.test(body))
    return true;

  // Future due / payment-due reminders.
  if (/is\s+due\s+on\s+\d{2}-\d{2}-\d{2}/i.test(body)) return true;

  // OTP / PIN / account-linking / banking-service / declined notifications.
  if (
    /\bOTP\b|\bSECRET\s+OTP\b|\bUPI\s+PIN\b|\bInternet\s+Banking\s+Login\s+ID\b|\baccount\s+is\s+being\s+linked\b|\bmessage\s+was\s+incomplete\b|\bhas\s+been\s+declined\b/i.test(
      body,
    )
  ) {
    return true;
  }

  // AutoPay activation confirmations describe future billing, not a debit.
  if (/auto\s*pay\s*activation/i.test(lower)) return true;

  // Credit-card bill payment confirmations are self-transfers between own
  // accounts, not income — the card's individual spends are already captured
  // one by one, so recording the bill payment double-counts (2026-07-17 audit:
  // 7 rows, ₹132,841 of fake income came from exactly this message).
  if (
    /payment\s+of\s+INR\s+[\d,.]+\s+has\s+been\s+received\s+towards\s+your\s+Axis\s+Bank\s+Credit\s+Card/i.test(
      body,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Axis UPI SMS may use either an email-style `UPI/P2M/SWIGGY` segment or an
 * SMS-style `UPI/P2M/123456/SWIGGY` segment with a numeric transaction id in
 * the middle. Try the merchant-looking segment first, fall back to the raw
 * capture.
 */
function extractAxisMerchant(body: string): string | null {
  // Stop the merchant capture at sentence punctuation, a Ref/UTR keyword, or
  // another UPI segment so we don't swallow the rest of the SMS.
  const stop = String.raw`(?:\.|,|\n|\s+(?:Ref|RRN|UTR|Txn))`;
  const patterns = [
    new RegExp(
      `Transaction Info:\\s*UPI\\/[A-Z0-9]+\\/[0-9]+\\/([A-Za-z][\\w\\s.]*?)(?=\\s*(?:${stop}|$))`,
      "i",
    ),
    new RegExp(
      `Transaction Info:\\s*UPI\\/[A-Z0-9]+\\/([A-Za-z][\\w\\s.]*?)(?=\\s*(?:${stop}|$))`,
      "i",
    ),
    new RegExp(
      `UPI\\/[A-Z0-9]+\\/[0-9]+\\/([A-Za-z][\\w\\s.]*?)(?=\\s*(?:${stop}|$))`,
      "i",
    ),
    new RegExp(
      `UPI\\/[A-Z0-9]+\\/([A-Za-z][\\w\\s.]*?)(?=\\s*(?:${stop}|$))`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

// "Amount Debited: INR 75.00 ... Date & Time: 01-04-26, 19:03:35 ... Transaction Info: UPI/P2M/..."
export const axisUpiDebit: Parser = (body) => {
  const amountMatch = body.match(/Amount Debited:\s*INR ([\d,]+\.?\d*)/i);
  const dateMatch = body.match(
    /Date & Time:\s*(\d{2}-\d{2}-\d{2}),?\s*(\d{2}:\d{2}:\d{2})/i,
  );

  if (!amountMatch || !dateMatch) return null;

  return {
    amount: parseAmount(amountMatch[1]),
    merchant: extractAxisMerchant(body) ?? "UPI Payment",
    date: parseAxisDate(dateMatch[1], dateMatch[2]),
    type: "expense",
    referenceNumber: extractReferenceNumber(body, REFERENCE_PATTERNS.axis),
    accountLast4: extractAccountLast4(body),
  };
};

// "Amount Credited: INR 500.00 ... Date & Time: 01-04-26, 10:00:00 ... Transaction Info: UPI/..."
export const axisUpiCredit: Parser = (body) => {
  const amountMatch = body.match(/Amount Credited:\s*INR ([\d,]+\.?\d*)/i);
  const dateMatch = body.match(
    /Date & Time:\s*(\d{2}-\d{2}-\d{2}),?\s*(\d{2}:\d{2}:\d{2})/i,
  );

  if (!amountMatch || !dateMatch) return null;

  return {
    amount: parseAmount(amountMatch[1]),
    merchant: extractAxisMerchant(body) ?? "Credit",
    date: parseAxisDate(dateMatch[1], dateMatch[2]),
    type: "income",
    referenceNumber: extractReferenceNumber(body, REFERENCE_PATTERNS.axis),
    accountLast4: extractAccountLast4(body),
  };
};

// "Transaction Amount: INR 399 Merchant Name: PLAYSTATION Axis Bank Credit Card No. XX3266 Date"
// snippet has date at the start: "31-03-2026"
export const axisCreditCard: Parser = (body) => {
  const amountMatch = body.match(/Transaction Amount:\s*INR ([\d,]+\.?\d*)/i);
  const merchantMatch = body.match(/Merchant Name:\s*([^\s].+?)(?:\s+Axis)/i);
  const dateMatch = body.match(/(\d{2}-\d{2}-\d{4})\s+Dear/i);

  if (!amountMatch) return null;

  let date: string | null;
  if (dateMatch) {
    const [day, month, year] = dateMatch[1].split("-");
    const shortYear = year.slice(2);
    date = parseAxisDate(`${day}-${month}-${shortYear}`);
  } else {
    const altDate = body.match(/Date[:\s]*(\d{2}-\d{2}-\d{2})/i);
    date = altDate ? parseAxisDate(altDate[1]) : null;
  }

  return {
    amount: parseAmount(amountMatch[1]),
    merchant: merchantMatch ? merchantMatch[1].trim() : "Credit Card Payment",
    date,
    type: "expense",
    referenceNumber: extractReferenceNumber(body, REFERENCE_PATTERNS.axis),
    accountLast4: extractAccountLast4(body),
  };
};

// "Your A/c has been debited towards {merchant} for INR {amount} on {date}. {token}@{provider} - Axis Bank"
export const axisAccountDebit: Parser = (body) => {
  const match = body.match(
    /Your\s+A\/c\s+has\s+been\s+debited\s+towards\s+(.+?)\s+for\s+INR\s+([\d,]+\.?\d*)\s+on\s+(\d{2}-\d{2}-\d{2})/i,
  );
  if (!match) return null;

  return {
    amount: parseAmount(match[2]),
    merchant: match[1].trim(),
    date: parseAxisDate(match[3]),
    type: "expense",
    // The hex@provider token is a recurring mandate / subscription id, not a
    // stable per-transaction reference; do not use it as reference_number.
    referenceNumber: null,
    accountLast4: extractAccountLast4(body),
  };
};

// Multi-line credit alert:
// "INR {amount} credited\nA/c no. XX{last4}\n{date}, {time} IST\nUPI/P2A/{ref}/PhonePe/YESB/C06 Cr - Axis Bank"
export const axisAccountCredit: Parser = (body) => {
  const amountMatch = body.match(/^INR\s+([\d,]+\.?\d*)\s+credited/im);
  const accountMatch = body.match(/A\/c\s+no\.\s+XX(\d{4})/i);
  const dateTimeMatch = body.match(
    /(\d{2}-\d{2}-\d{2}),\s*(\d{2}:\d{2}:\d{2})\s+IST/i,
  );
  const upiMatch = body.match(/UPI\/[A-Z0-9]+\/([0-9]+)\//i);

  if (!amountMatch || !dateTimeMatch) return null;

  return {
    amount: parseAmount(amountMatch[1]),
    merchant: extractAxisMerchant(body) ?? "UPI Credit",
    date: parseAxisDate(dateTimeMatch[1], dateTimeMatch[2]),
    type: "income",
    referenceNumber: upiMatch?.[1] ?? null,
    accountLast4: accountMatch?.[1] ?? null,
  };
};

// "NACH debit towards {merchant} for INR {amount} with UMRN {ref} has been successfully processed in A/c no. XX{last4} today - Axis Bank"
export const axisNachDebit: Parser = (body) => {
  const match = body.match(
    /NACH\s+debit\s+towards\s+(.+?)\s+for\s+INR\s+([\d,]+\.?\d*)\s+with\s+UMRN\s+(\S+)\s+has\s+been\s+successfully\s+processed/i,
  );
  if (!match) return null;

  return {
    amount: parseAmount(match[2]),
    merchant: match[1].trim(),
    date: null,
    type: "expense",
    referenceNumber: match[3],
    accountLast4: extractAccountLast4(body),
  };
};

// "INR {amount} credited to A/c no. XX{last4} on {DD-MM-YY} at {HH:mm:ss} IST. Info - NEFT/CMS{ref}/{remitter}. ..."
// The single-line NEFT/IMPS credit format ("on ... at ... IST", no comma) that
// axisAccountCredit's comma-separated multi-line regex misses. This is the
// format monthly salary credits arrive in — the 2026-07-17 audit found 10 of
// them (~₹27L) sitting unparsed in `failed` because no parser matched it.
export const axisNeftCredit: Parser = (body) => {
  const match = body.match(
    /INR\s+([\d,]+\.?\d*)\s+credited\s+to\s+A\/c\s+no\.\s+XX(\d{4})\s+on\s+(\d{2}-\d{2}-\d{2})\s+at\s+(\d{2}:\d{2}:\d{2})/i,
  );
  if (!match) return null;

  const infoMatch = body.match(
    /Info\s*[-:]\s*(?:NEFT|IMPS|RTGS)\/([A-Z0-9]+)\/([^./\n]+)/i,
  );

  return {
    amount: parseAmount(match[1]),
    merchant: infoMatch ? infoMatch[2].trim() : "NEFT Credit",
    date: parseAxisDate(match[3], match[4]),
    type: "income",
    referenceNumber: infoMatch?.[1] ?? null,
    accountLast4: match[2],
  };
};

// "UPI LITE top-up on UPI App amounting to INR {amount} has been successful. Ref no. {ref} - Axis Bank"
export const axisUpiLiteTopup: Parser = (body) => {
  const match = body.match(
    /UPI\s+LITE\s+top-up\s+on\s+UPI\s+App\s+amounting\s+to\s+INR\s+([\d,]+\.?\d*)\s+has\s+been\s+successful/i,
  );
  if (!match) return null;

  return {
    amount: parseAmount(match[1]),
    merchant: "UPI LITE Top-up",
    date: null,
    type: "expense",
    referenceNumber: extractReferenceNumber(body, REFERENCE_PATTERNS.axis),
    accountLast4: null,
  };
};

// Multi-line debit alert:
// "INR {amount} debited\nA/c no. XX{last4}\n{date}, {time}\nUPI/P2M/{ref}/{merchant}\nNot you? SMS BLOCKUPI ..."
export const axisAccountDebitMultiLine: Parser = (body) => {
  const amountMatch = body.match(/^INR\s+([\d,]+\.?\d*)\s+debited/im);
  const accountMatch = body.match(/A\/c\s+no\.\s+XX(\d{4})/i);
  const dateTimeMatch = body.match(
    /(\d{2}-\d{2}-\d{2}),\s*(\d{2}:\d{2}:\d{2})/i,
  );
  const upiMatch = body.match(/UPI\/[A-Z0-9]+\/([0-9]+)\//i);

  if (!amountMatch || !dateTimeMatch) return null;

  return {
    amount: parseAmount(amountMatch[1]),
    merchant: extractAxisMerchant(body) ?? "UPI Payment",
    date: parseAxisDate(dateTimeMatch[1], dateTimeMatch[2]),
    type: "expense",
    referenceNumber: upiMatch?.[1] ?? null,
    accountLast4: accountMatch?.[1] ?? null,
  };
};

// Multi-line credit-card spend alert. Axis uses a few closely related layouts:
// "Spent\nCard no. XX{last4}\nUSD {amount}\n{date} {time}\n{merchant}\nAvl Lmt INR ..."
// "Spent USD {amount}\nAxis Bank Card no. XX{last4}\n{date} {time} IST\n{merchant}\nAvl Limit: INR ..."
// "Spent INR {amount}\nAxis Bank Card no. XX{last4}\n{date} {time} IST\n{merchant}\nAvl Limit: INR ..."
export const axisCardSpend: Parser = (body) => {
  if (!/^Spent\b/im.test(body)) return null;

  // Amount may be on the same line as "Spent" or on the following currency line.
  // Capture the currency token too: international card spends quote USD/EUR/GBP
  // and storing the bare number as INR was the 2026-07-17 audit's
  // foreign-currency bug (23 rows, every USD-billed subscription affected).
  const sameLineAmount = body.match(
    /^Spent\s+(INR|Rs\.?|USD|EUR|GBP)\s*([\d,]+\.?\d*)\s*$/im,
  );
  const currencyLineAmount = body.match(
    /^(INR|Rs\.?|USD|EUR|GBP)\s*([\d,]+\.?\d*)\s*$/im,
  );
  const amountMatch = sameLineAmount ?? currencyLineAmount;

  const dateTimeMatch = body.match(
    /(\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s+IST)?/i,
  );
  const accountMatch = body.match(/Card\s+no\.\s+XX(\d{4})/i);

  // Merchant is the line immediately after the date/time line.
  const merchantMatch = dateTimeMatch
    ? body.match(
        new RegExp(
          `${dateTimeMatch[2]}(?:\\s+IST)?\\s*\\r?\\n([A-Z][A-Za-z0-9 ./*&-]{2,40})(?=\\r?\\n)`,
          "i",
        ),
      )
    : null;

  if (!amountMatch || !dateTimeMatch) return null;

  const currencyToken = amountMatch[1].toUpperCase().replace(/^RS\.?$/, "INR");
  const amount = parseAmount(amountMatch[2]);
  const isForeign = currencyToken !== "INR";

  return {
    amount,
    merchant: merchantMatch ? merchantMatch[1].trim() : "Card Payment",
    date: parseAxisDate(dateTimeMatch[1], dateTimeMatch[2]),
    type: "expense",
    referenceNumber: null,
    accountLast4: accountMatch?.[1] ?? null,
    // For foreign spends the parsed number is NOT INR: report the currency and
    // original amount so the pipeline converts (and routes to AI proofread).
    currency: isForeign ? currencyToken : undefined,
    originalAmount: isForeign ? amount : undefined,
  };
};

/** Wrap an Axis parser so non-transaction notices are never matched. */
function withAxisGuard(parser: Parser): Parser {
  return (body) => {
    if (isAxisNonTransactionNotice(body)) return null;
    return parser(body);
  };
}

// generic fallback: "spent/debited INR X at merchant on DD-MM-YY"
export const axisGenericDebit: Parser = (body) => {
  const amountMatch = body.match(
    /(?:spent|debited)\s*(?:INR|Rs\.?)\s*([\d,]+\.?\d*)/i,
  );
  const dateMatch = body.match(
    /(?:on|dated?)\s*(\d{2}-\d{2}-\d{2}),?\s*(\d{2}:\d{2}:\d{2})?/i,
  );
  const merchantMatch = body.match(/(?:at|towards)\s+(.+?)(?:\s+on|\s+dated)/i);

  if (!amountMatch || !dateMatch) return null;

  return {
    amount: parseAmount(amountMatch[1]),
    merchant: merchantMatch ? merchantMatch[1].trim() : "Card Payment",
    date: parseAxisDate(dateMatch[1], dateMatch[2]),
    type: "expense",
    referenceNumber: extractReferenceNumber(body, REFERENCE_PATTERNS.axis),
    accountLast4: extractAccountLast4(body),
  };
};

export const AXIS_PARSERS: Parser[] = [
  withAxisGuard(axisUpiDebit),
  withAxisGuard(axisUpiCredit),
  withAxisGuard(axisCreditCard),
  withAxisGuard(axisAccountDebit),
  withAxisGuard(axisAccountDebitMultiLine),
  withAxisGuard(axisAccountCredit),
  withAxisGuard(axisCardSpend),
  withAxisGuard(axisNachDebit),
  withAxisGuard(axisNeftCredit),
  withAxisGuard(axisUpiLiteTopup),
  withAxisGuard(axisGenericDebit),
];

export { BANK_NAME, PARSER_KEY, isAxisNonTransactionNotice };
