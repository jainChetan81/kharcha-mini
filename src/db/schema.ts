import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type", { enum: ["income", "expense", "investment"] }).notNull(),
    amount: real("amount").notNull(),
    merchant: text("merchant").notNull(),
    merchantCanonical: text("merchant_canonical"),
    category: text("category"),
    date: text("date").notNull(),
    rawText: text("raw_text").notNull(),
    senderId: text("sender_id").notNull(),
    bankName: text("bank_name"),
    parserKey: text("parser_key"),
    parsedBy: text("parsed_by", {
      enum: ["regex", "openrouter", "failed", "manual"],
    }).notNull(),
    confidence: text("confidence", {
      enum: ["high", "medium", "low"],
    })
      .notNull()
      .default("medium"),
    referenceNumber: text("reference_number"),
    accountLast4: text("account_last4"),
    fingerprint: text("fingerprint").notNull(),
    sourceMessageGuid: text("source_message_guid").notNull().unique(),
    syncStatus: text("sync_status", {
      enum: ["pending", "synced"],
    })
      .notNull()
      .default("pending"),
    syncedAt: text("synced_at"),
    createdAt: text("created_at").default("(datetime('now'))"),
    updatedAt: text("updated_at").default("(datetime('now'))"),
  },
  (table) => ({
    fingerprintIdx: index("fingerprint_idx").on(table.fingerprint),
  }),
);

export const senderAllowlist = sqliteTable("sender_allowlist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Core bank DLT code (e.g. 'AXISBK', 'HDFCBK'). Stored uppercase.
  // Matching is substring containment against the raw chat.db handle.id,
  // because carriers and Apple's SMS-forwarding relay add prefixes/suffixes.
  bankCode: text("bank_code").notNull().unique(),
  bankName: text("bank_name"),
  parserKey: text("parser_key"),
  isActive: integer("is_active").notNull().default(1),
});

export const config = sqliteTable("config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const merchantAliases = sqliteTable(
  "merchant_aliases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    rawPattern: text("raw_pattern").notNull().unique(),
    canonicalMerchant: text("canonical_merchant").notNull(),
    category: text("category"),
    source: text("source", { enum: ["auto", "manual"] })
      .notNull()
      .default("auto"),
    hitCount: integer("hit_count").notNull().default(0),
    createdAt: text("created_at").default("(datetime('now'))"),
    updatedAt: text("updated_at").default("(datetime('now'))"),
  },
  (table) => ({
    rawPatternIdx: index("merchant_aliases_raw_pattern_idx").on(
      table.rawPattern,
    ),
  }),
);
