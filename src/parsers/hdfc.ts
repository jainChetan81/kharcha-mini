import {
  extractAccountLast4,
  extractReferenceNumber,
  MERCHANT_REGEX,
  REFERENCE_PATTERNS,
  type Parser,
  parseAmount,
  parseHdfcDate,
} from "./utils";

const BANK_NAME = "HDFC Bank";
const PARSER_KEY = "hdfc";

/**
 * HDFC sends a lot of notices that are not completed transactions: statements,
 * payment-due / overdue reminders, OTPs, payment-appreciation messages, etc.
 * Reject these outright so they never look like a transaction.
 */
function isHdfcNonTransactionNotice(body: string): boolean {
  const lower = body.toLowerCase();

  // Statements are never transactions.
  if (/statement\s*(?:generated\s*:|for\s+hdfc\s+bank\s+credit\s+card|:\s*total\s+due)/i.test(body))
    return true;

  // E-mandate / upcoming / scheduled / conditional future debits.
  if (
    /(?:e-?mandate|upcoming\s+(?:mandate|debit|payment|transaction)|will\s+be\s+(?:debited|charged|auto-?debited)|scheduled\s+(?:for|on)|shall\s+be\s+debited)/i.test(
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

  // Payment-due / overdue / reminder messages (including PayZapp links).
  if (
    /(?:amount\s+due|total\s+due|min\.?\s*due|pay\s+(?:by|instantly\s+by)|reminder!|is\s+(?:over)?due|clear\s+your\s+dues|link\s+to\s+quickly\s+pay)/i.test(
      body,
    )
  ) {
    return true;
  }

  // Payment-acknowledgment / pending-balance messages.
  if (/we\s+appreciate\s+the\s+recent\s+payment|remains\s+pending/i.test(body))
    return true;

  // OTP / PIN / account-linking / declined notifications.
  if (
    /\bOTP\b|\bis\s+your\s+OTP\b|\bUPI\s+PIN\b|\bInternet\s+Banking\s+Login\s+ID\b|\baccount\s+is\s+being\s+linked\b|\bmessage\s+was\s+incomplete\b|\bhas\s+been\s+declined\b/i.test(
      body,
    )
  ) {
    return true;
  }

  // AutoPay activation confirmations describe future billing, not a debit.
  if (/auto\s*pay\s*activation/i.test(lower)) return true;

  return false;
}

/** Wrap an HDFC parser so non-transaction notices are never matched. */
function withHdfcGuard(parser: Parser): Parser {
  return (body) => {
    if (isHdfcNonTransactionNotice(body)) return null;
    return parser(body);
  };
}

// "Rs.X debited from your HDFC Bank ... ending 1234 towards merchant on DD Mon, YYYY"
export const hdfcDebit: Parser = (body) => {
  const match = body.match(
    /Rs\.([\d,]+\.?\d*)\s+(?:is\s+)?debited\s+from\s+(?:your\s+)?HDFC\s+Bank.*?ending\s+(?:\*|X)?(\d+)\s+towards\s+(.+?)\s+on\s+(\d{2}\s+\w+,?\s+\d{4}|\d{2}-\d{2}-\d{2,4})(?:\s+at\s+(\d{2}:\d{2}:\d{2}))?/i,
  );

  if (!match) return null;

  return {
    amount: parseAmount(match[1]),
    merchant: match[3].trim(),
    date: parseHdfcDate(match[4], match[5]),
    type: "expense",
    referenceNumber: extractReferenceNumber(body, REFERENCE_PATTERNS.hdfc),
    accountLast4: match[2],
  };
};

// "Rs.X credited to your HDFC Bank A/c ... ending 1234 on DD Mon, YYYY"
export const hdfcCredit: Parser = (body) => {
  const match = body.match(
    /Rs\.([\d,]+\.?\d*)\s+(?:is\s+)?credited\s+to\s+(?:your\s+)?HDFC\s+Bank.*?ending\s+(?:\*|X)?(\d+)\s+(?:on|dated)\s+(\d{2}\s+\w+,?\s+\d{4}|\d{2}-\d{2}-\d{2,4})(?:\s+at\s+(\d{2}:\d{2}:\d{2}))?/i,
  );
  if (!match) return null;

  const merchantMatch = body.match(
    /(?:from\s+|by\s+|Info[:\s]*)([A-Za-z][\w\s./-]{2,40}?)(?:\s+on\s|\s*$)/i,
  );

  return {
    amount: parseAmount(match[1]),
    merchant: merchantMatch ? merchantMatch[1].trim() : "HDFC Credit",
    date: parseHdfcDate(match[3], match[4]),
    type: "income",
    referenceNumber: extractReferenceNumber(body, REFERENCE_PATTERNS.hdfc),
    accountLast4: match[2],
  };
};

// "Rs.X has been debited from your HDFC Bank [RuPay] Credit Card XX1234 to MERCHANT on DD-MM-YY"
export const hdfcUpiCreditCard: Parser = (body) => {
  const match = body.match(
    /Rs\.?\s*([\d,]+\.?\d*)\s+has\s+been\s+debited\s+from\s+your\s+HDFC\s+Bank[\w\s]*Credit\s+Card\s+(?:XX|ending\s+)?(\d+)\s+to\s+(.+)\s+on\s+(\d{2}[-/]\d{2}[-/]\d{2,4})\b/i,
  );
  if (!match) return null;

  return {
    amount: parseAmount(match[1]),
    merchant: match[3].trim(),
    date: parseHdfcDate(match[4]),
    type: "expense",
    referenceNumber: extractReferenceNumber(body, REFERENCE_PATTERNS.hdfc),
    accountLast4: match[2],
  };
};

// "Spent Rs.245 On HDFC Bank Card 2047 At PYU*Swiggy Food On 2026-03-19:11:12:38.Not You? ..."
export const hdfcCardSpent: Parser = (body) => {
  const match = body.match(
    /^Spent\s+Rs\.?\s*([\d,]+\.?\d*)\s+On\s+HDFC\s+Bank\s+Card\s+(\d{4})\s+At\s+(.+?)\s+On\s+(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2}:\d{2})/i,
  );
  if (!match) return null;

  return {
    amount: parseAmount(match[1]),
    merchant: match[3].trim(),
    date: parseHdfcDate(match[4], match[5]),
    type: "expense",
    referenceNumber: null,
    accountLast4: match[2],
    confidence: "high",
  };
};

// "Your HDFC Bank Credit Card ending 1234 has been used for Rs.2500 at MERCHANT on DD-Mon-YYYY"
// "Thank you for using your HDFC Bank Credit Card ending 1234 for Rs 999.00 at MERCHANT on DD/MM/YYYY"
export const hdfcCreditCard: Parser = (body) => {
  if (!body.match(/HDFC/i)) return null;
  if (!body.match(/(?:credit\s*card|card\s+ending)/i)) return null;

  // Skip e-mandate / upcoming-debit notices — these announce a future
  // auto-payment, not a completed transaction, and would double-count when
  // the real debit arrives.
  if (
    body.match(
      /(?:e-?mandate|upcoming\s+(?:debit|payment|transaction)|will\s+be\s+(?:debited|charged|auto-?debited)|scheduled\s+(?:for|on)|shall\s+be\s+debited)/i,
    )
  ) {
    return null;
  }
  if (body.match(/\be-?mandate\b/i)) {
    const isPastTense = body.match(
      /(?:has\s+been|have\s+been|was|were)\s+(?:debited|charged)/i,
    );
    if (!isPastTense) return null;
  }

  const amountMatch = body.match(
    /(?:for|of)\s+(?:Rs\.?|INR)\s*([\d,]+\.?\d*)/i,
  );
  if (!amountMatch) return null;

  const merchantMatch = body.match(MERCHANT_REGEX);
  const dateMatch = body.match(
    /on\s+(\d{2}\s+\w+,?\s+\d{4})(?:\s+at\s+(\d{2}:\d{2}:\d{2}))?/i,
  );
  const accountMatch = body.match(/(?:ending|XX)(\d{4})/i);

  return {
    amount: parseAmount(amountMatch[1]),
    merchant: merchantMatch ? merchantMatch[1].trim() : "HDFC Card Payment",
    date: dateMatch ? parseHdfcDate(dateMatch[1], dateMatch[2]) : null,
    type: "expense",
    referenceNumber: extractReferenceNumber(body, REFERENCE_PATTERNS.hdfc),
    accountLast4: accountMatch?.[1] ?? null,
  };
};

export const HDFC_PARSERS: Parser[] = [
  withHdfcGuard(hdfcCardSpent),
  withHdfcGuard(hdfcUpiCreditCard),
  withHdfcGuard(hdfcCreditCard),
  withHdfcGuard(hdfcDebit),
  withHdfcGuard(hdfcCredit),
];

export { BANK_NAME, PARSER_KEY, isHdfcNonTransactionNotice };
