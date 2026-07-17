import { format } from "date-fns";
import {
  DATE_TIME_FORMAT,
  extractAccountLast4,
  extractReferenceNumber,
  REFERENCE_PATTERNS,
  type Parser,
  parseAmount,
  parseIndianDate,
} from "./utils";

const BANK_NAME = "IndusInd Bank";
const PARSER_KEY = "indusind";

const today = () => format(new Date(), DATE_TIME_FORMAT);

// "Debited for INR 200.00 towards UPI/140853857998/DR/TRIS/FDRL/..."
export const indusindUpiDebit: Parser = (body) => {
  const amountMatch = body.match(/Debited for INR ([\d,]+\.?\d*)/i);
  const upiMatch = body.match(/towards\s+UPI\/[\d]+\/DR\/([^/]+)/i);

  if (!amountMatch) return null;

  return {
    amount: parseAmount(amountMatch[1]),
    merchant: upiMatch ? upiMatch[1].trim() : "UPI Payment",
    date: today(),
    type: "expense",
    referenceNumber: extractReferenceNumber(body, REFERENCE_PATTERNS.indusind),
    accountLast4: extractAccountLast4(body),
  };
};

// "Credited for INR X towards UPI/..."
export const indusindUpiCredit: Parser = (body) => {
  const amountMatch = body.match(/Credited for INR ([\d,]+\.?\d*)/i);
  const upiMatch = body.match(/towards\s+UPI\/[\d]+\/CR\/([^/]+)/i);

  if (!amountMatch) return null;

  return {
    amount: parseAmount(amountMatch[1]),
    merchant: upiMatch ? upiMatch[1].trim() : "Credit",
    date: today(),
    type: "income",
    referenceNumber: extractReferenceNumber(body, REFERENCE_PATTERNS.indusind),
    accountLast4: extractAccountLast4(body),
  };
};

// generic fallback: "Debited for INR X towards ..."
export const indusindGenericDebit: Parser = (body) => {
  const amountMatch = body.match(/Debited for INR ([\d,]+\.?\d*)/i);
  const towardsMatch = body.match(/towards\s+(.+?)(?:\s*\.|$)/i);

  if (!amountMatch) return null;

  const rawMerchant = towardsMatch ? towardsMatch[1].trim() : "Payment";
  const merchant =
    rawMerchant.length > 40 ? rawMerchant.slice(0, 40) : rawMerchant;

  return {
    amount: parseAmount(amountMatch[1]),
    merchant,
    date: today(),
    type: "expense",
    referenceNumber: extractReferenceNumber(body, REFERENCE_PATTERNS.indusind),
    accountLast4: extractAccountLast4(body),
  };
};

// "account XXXXXXX0002 is credited by Rs.400000 on 24-03-26 received from account XXXXXXX1794/ADITYA PRA (IMPS Ref no. 608318599522)"
export const indusindImpsCredit: Parser = (body) => {
  const amountMatch = body.match(/credited by Rs\.?([\d,]+\.?\d*)/i);
  const dateMatch = body.match(/on (\d{2}-\d{2}-\d{2})/i);
  const fromMatch = body.match(
    /received from account\s+[\dX]+\/([\w\s]+?)(?:\s*\(|$)/i,
  );

  if (!amountMatch) return null;

  let date = today();
  if (dateMatch) {
    date = parseIndianDate(dateMatch[1]) ?? today();
  }

  return {
    amount: parseAmount(amountMatch[1]),
    merchant: fromMatch ? fromMatch[1].trim() : "IMPS Credit",
    date,
    type: "income",
    referenceNumber: extractReferenceNumber(body, REFERENCE_PATTERNS.indusind),
    accountLast4: extractAccountLast4(body),
  };
};

export const INDUSIND_PARSERS: Parser[] = [
  indusindUpiDebit,
  indusindUpiCredit,
  indusindImpsCredit,
  indusindGenericDebit,
];

export { BANK_NAME, PARSER_KEY };
