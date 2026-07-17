import { format, parse } from "date-fns";

export const DATE_TIME_FORMAT = "yyyy-MM-dd HH:mm";

export interface ParsedTransaction {
  amount: number;
  merchant: string;
  date: string | null;
  type: "expense" | "income" | "investment";
  category?: string;
  confidence?: "high" | "medium" | "low";
  isSubscription?: boolean;
  billingDay?: number | null;
  /** Bank reference / UTR / RRN extracted from the alert text. */
  referenceNumber?: string | null;
  /** Last 4 digits of the account/card used. */
  accountLast4?: string | null;
  /** ISO 4217 code when the SMS states a non-INR currency (e.g. "USD").
   * Undefined/"INR" means the amount is already INR. */
  currency?: string | null;
  /** Amount in `currency` exactly as the SMS states it (foreign spends). */
  originalAmount?: number | null;
  /** Set when the stored INR amount was derived via a fallback FX rate and
   * should be surfaced for human review. */
  needsReview?: boolean;
}

export type Parser = (body: string) => ParsedTransaction | null;

export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Current datetime as the standard fallback when no date can be extracted. */
export function fallbackNow(): string {
  return format(new Date(), DATE_TIME_FORMAT);
}

const INDIAN_DATE_FORMATS = [
  "ddMMMyy",
  "ddMMMyyyy",
  "dd-MM-yy",
  "dd-MM-yyyy",
  "dd/MM/yyyy",
  "dd-MMM-yy",
  "dd-MMM-yyyy",
  "dd MMM yyyy",
  "dd MMM, yyyy",
  "yyyy-MM-dd",
];

export function parseIndianDate(raw: string, rawTime?: string): string | null {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  const timeStr = rawTime?.trim();

  if (timeStr) {
    for (const fmt of INDIAN_DATE_FORMATS) {
      try {
        const d = parse(`${cleaned} ${timeStr}`, `${fmt} HH:mm:ss`, new Date());
        if (!Number.isNaN(d.getTime())) return format(d, DATE_TIME_FORMAT);
      } catch {}
    }
  }

  for (const fmt of INDIAN_DATE_FORMATS) {
    try {
      const nospace = cleaned.replace(/\s+/g, "");
      const d = fmt.includes(" ")
        ? parse(cleaned, fmt, new Date())
        : parse(nospace, fmt, new Date());
      if (!Number.isNaN(d.getTime())) return format(d, DATE_TIME_FORMAT);
    } catch {}
  }
  return null;
}

export function parseAxisDate(
  rawDate: string,
  rawTime?: string,
): string | null {
  return parseIndianDate(rawDate, rawTime);
}

export function parseHdfcDate(
  rawDate: string,
  rawTime?: string,
): string | null {
  return parseIndianDate(rawDate, rawTime);
}

export function parseAmount(str: string): number {
  return Number.parseFloat(str.replace(/,/g, ""));
}

/** Regex that extracts a date after "on" — covers common Indian banking formats. */
export const DATE_REGEX =
  /on\s+(\d{2}\s*\w{3}\s*\d{2,4}|\d{2}[-/]\w{3}[-/]\d{2,4}|\d{2}[-/]\d{2}[-/]\d{2,4}|\d{2}\s+\w{3}\s+\d{4})/i;

/** Regex that extracts a merchant name after at/towards. */
export const MERCHANT_REGEX =
  /(?:at|towards)\s+([A-Za-z][\w\s./-]{2,40}?)(?:\s+on\s|\s+dated|\s*$)/i;

export function tryParsers(
  parsers: Parser[],
  body: string,
): ParsedTransaction | null {
  for (const parser of parsers) {
    const result = parser(body);
    if (result) return result;
  }
  return null;
}

// --- Reference-number helpers (SMS-specific additions) ---

const AXIS_REF_PATTERNS = [
  /(?:Ref\s*(?:No|Number)|RRN|UTR)[.:\s#]+([A-Z0-9]{6,20})/i,
];

const HDFC_REF_PATTERNS = [
  /(?:Ref\s*(?:No|Number)|UTR|RRN)[.:\s#]+([A-Z0-9]{6,22})/i,
  /(?:UPI\s*Ref|IMPS\s*Ref)[.:\s#]+([A-Z0-9]{6,22})/i,
  /(?:Txn\s*ID|Transaction\s*ID)[.:\s#]+([A-Z0-9]{6,22})/i,
];

const INDUSIND_REF_PATTERNS = [
  /(?:Ref\s*(?:No|Number)|UTR|RRN|IMPS\s*Ref\s*no)[.:\s#]+([A-Z0-9]{6,22})/i,
  /UPI\/([\d]{6,20})/i,
];

/**
 * Scan a bank alert for a reference / UTR / RRN string. Returns the first
 * reasonable-looking match or null if nothing fits.
 */
export function extractReferenceNumber(
  body: string,
  patterns: RegExp[],
): string | null {
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match?.[1]) {
      const ref = match[1].trim();
      if (/^[A-Z0-9]{6,}$/i.test(ref)) return ref.toUpperCase();
    }
  }
  return null;
}

export const REFERENCE_PATTERNS: Record<string, RegExp[]> = {
  axis: AXIS_REF_PATTERNS,
  hdfc: HDFC_REF_PATTERNS,
  indusind: INDUSIND_REF_PATTERNS,
};

/** Extract the last 4 digits of an account or card number when explicitly present. */
export function extractAccountLast4(body: string): string | null {
  const match = body.match(/(?:ending|XX|a\/c\s*no\.?\s*X+)(\d{4})/i);
  return match?.[1] ?? null;
}
