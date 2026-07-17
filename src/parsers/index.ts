import { BANK_NAME as AXIS_BANK_NAME, AXIS_PARSERS, PARSER_KEY as AXIS_PARSER_KEY } from "./axis";
import { BANK_NAME as HDFC_BANK_NAME, HDFC_PARSERS, PARSER_KEY as HDFC_PARSER_KEY } from "./hdfc";
import { BANK_NAME as INDUSIND_BANK_NAME, INDUSIND_PARSERS, PARSER_KEY as INDUSIND_PARSER_KEY } from "./indusind";
import { decodeHtmlEntities, tryParsers, type ParsedTransaction, type Parser } from "./utils";

export type { ParsedTransaction };
export { tryParsers };

export interface ParseOutcome {
  parsed: ParsedTransaction | null;
  parsedBy: "regex" | "openrouter" | "failed";
  bankName: string | null;
  parserKey: string | null;
}

const PARSER_MAP: Record<string, { parsers: Parser[]; bankName: string; parserKey: string }> = {
  axis: { parsers: AXIS_PARSERS, bankName: AXIS_BANK_NAME, parserKey: AXIS_PARSER_KEY },
  hdfc: { parsers: HDFC_PARSERS, bankName: HDFC_BANK_NAME, parserKey: HDFC_PARSER_KEY },
  indusind: { parsers: INDUSIND_PARSERS, bankName: INDUSIND_BANK_NAME, parserKey: INDUSIND_PARSER_KEY },
};

export function parseMessage(
  parserKey: string | null,
  rawBody: string,
): ParseOutcome {
  const body = decodeHtmlEntities(rawBody);

  if (parserKey && PARSER_MAP[parserKey]) {
    const { parsers, bankName } = PARSER_MAP[parserKey];
    const result = tryParsers(parsers, body);
    if (result) {
      return {
        parsed: result,
        parsedBy: "regex",
        bankName,
        parserKey,
      };
    }
  }

  return {
    parsed: null,
    parsedBy: "failed",
    bankName: parserKey ? PARSER_MAP[parserKey]?.bankName ?? null : null,
    parserKey,
  };
}

export function getBankName(parserKey: string | null): string | null {
  return parserKey ? (PARSER_MAP[parserKey]?.bankName ?? null) : null;
}
