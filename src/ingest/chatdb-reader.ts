import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const CHAT_DB_PATH = `${process.env.KHARCHA_CHAT_DB ?? join(homedir(), "Library", "Messages", "chat.db")}`;

// Core Data epoch: 2001-01-01 UTC. message.date is nanoseconds since then.
const APPLE_EPOCH_MS = 978307200_000;

export interface ChatMessage {
  rowid: number;
  guid: string;
  text: string;
  date: Date;
  service: string | null;
  senderId: string | null;
}

/**
 * Newer macOS sometimes stores the message text only in `attributedBody`
 * (an NSKeyedArchiver / typedstream blob) with `text` left NULL.
 * This is a best-effort NSString payload extractor — matches the working
 * precedent in ~/.claude/plugins/marketplaces/claude-plugins-official/
 * external_plugins/imessage/server.ts.
 */
export function extractAttributedBodyText(blob: Uint8Array | null): string | null {
  if (!blob) return null;
  const buf = Buffer.from(blob);
  let i = buf.indexOf("NSString");
  if (i < 0) return null;
  i += "NSString".length;
  // Skip class metadata until the '+' (0x2B) marking the inline string payload.
  while (i < buf.length && buf[i] !== 0x2b) i++;
  if (i >= buf.length) return null;
  i++;
  // Streamtyped length prefix: small lengths are literal bytes; 0x81/0x82/0x83
  // escape to 1/2/3-byte little-endian lengths respectively.
  let len: number;
  const b = buf[i++];
  if (b === 0x81) {
    len = buf[i];
    i += 1;
  } else if (b === 0x82) {
    len = buf.readUInt16LE(i);
    i += 2;
  } else if (b === 0x83) {
    len = buf.readUIntLE(i, 3);
    i += 3;
  } else {
    len = b;
  }
  if (i + len > buf.length) return null;
  // The streamtyped NSString payload is prefixed by a 0x00 or 0x01 type
  // marker that is included in the length but is not part of the actual text.
  // Skip it so the decoded string never begins with a control byte.
  if (buf[i] === 0x00 || buf[i] === 0x01) {
    i++;
    len--;
  }
  if (len <= 0) return null;
  return buf.toString("utf8", i, i + len);
}

/**
 * Open the live Messages database read-only. Never open read-write:
 * Messages.app writes continuously in WAL mode and a write handle risks
 * lock contention / store corruption.
 */
export function openChatDb(): Database {
  const db = new Database(CHAT_DB_PATH, { readonly: true });
  // Sanity check that we can read from it (TCC / FDA will throw here if absent).
  db.query("SELECT ROWID FROM message LIMIT 1").get();
  return db;
}

export interface QueryOptions {
  bankCodes: string[];
  afterRowid: number;
  limit?: number;
}

export function queryMessages(
  db: Database,
  options: QueryOptions,
): ChatMessage[] {
  const { bankCodes, afterRowid, limit = 500 } = options;
  if (bankCodes.length === 0) return [];

  // Substring containment: a single bank code like 'AXISBK' must match many
  // carrier/relay variants ('AX-AXISBK-S', 'AXISBK-S(smsft_fi)', etc.).
  // Build one LIKE placeholder per code; codes are bound as params.
  const likeClauses = bankCodes
    .map(() => "h.id LIKE '%' || ? || '%'")
    .join(" OR ");
  const params: (string | number)[] = [...bankCodes, afterRowid, limit];

  const sql = `
    SELECT
      m.ROWID AS rowid,
      m.guid AS guid,
      m.text AS text,
      m.attributedBody AS attributedBody,
      m.date AS date,
      m.service AS service,
      h.id AS senderId
    FROM message m
    JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.is_from_me = 0
      AND m.service IN ('SMS', 'RCS')
      AND (${likeClauses})
      AND m.ROWID > ?
    ORDER BY m.ROWID ASC
    LIMIT ?
  `;

  const query = db.query<
    {
      rowid: number;
      guid: string;
      text: string | null;
      attributedBody: Uint8Array | null;
      date: number;
      service: string | null;
      senderId: string | null;
    },
    (string | number)[]
  >(sql);

  const rows = query.all(...params);
  return rows
    .map((r) => {
      const text = r.text ?? extractAttributedBodyText(r.attributedBody) ?? "";
      return {
        rowid: r.rowid,
        guid: r.guid,
        text,
        date: new Date(r.date / 1e6 + APPLE_EPOCH_MS),
        service: r.service,
        senderId: r.senderId,
      };
    })
    .filter((m) => m.text.trim().length > 0);
}
