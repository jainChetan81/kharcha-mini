import { ensureSchema } from "../db/bootstrap";
import { upsertAllowlistEntry } from "../ingest/allowlist";

/**
 * One-time CLI to seed core bank DLT codes from the owner's iPhone SMS inbox.
 *
 * These codes are not in any codebase; collect them from actual forwarded bank
 * messages in ~/Library/Messages/chat.db once Full Disk Access is granted.
 *
 * Store only the stable core code (e.g. 'HDFCBK', 'AXISBK'), not every carrier
 * or relay variant. Matching is substring containment, so 'AXISBK' matches
 * 'AX-AXISBK-S', 'AXISBK-S(smsft_fi)', 'AXISBK-T(smsft)', etc.
 *
 * Usage:
 *   bun run seed:allowlist HDFCBK "HDFC Bank" hdfc AXISBK "Axis Bank" axis
 *
 * Arguments are triples: bank_code bank_name parser_key
 * The parser_key may be omitted for senders that don't have a regex template yet.
 */
async function main(): Promise<void> {
  ensureSchema();

  const args = process.argv.slice(2);

  if (args.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      "usage: bun run seed:allowlist <bank_code> <bank_name> [parser_key] ...",
    );
    process.exit(1);
  }

  const knownParsers = new Set(["axis", "hdfc", "indusind"]);

  let i = 0;
  while (i < args.length) {
    if (i + 1 >= args.length) {
      // eslint-disable-next-line no-console
      console.error(`unexpected trailing argument: ${args[i]}`);
      process.exit(1);
    }

    const bankCode = args[i++];
    const bankName = args[i++];
    const maybeParserKey = args[i];
    const parserKey =
      maybeParserKey && knownParsers.has(maybeParserKey.toLowerCase())
        ? maybeParserKey.toLowerCase()
        : null;
    if (parserKey) i++;

    await upsertAllowlistEntry(bankCode, bankName, parserKey);
    // eslint-disable-next-line no-console
    console.log(
      `allowlist: ${bankCode.toUpperCase()} -> ${bankName}${parserKey ? ` (${parserKey})` : ""}`,
    );
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("seed-allowlist failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
