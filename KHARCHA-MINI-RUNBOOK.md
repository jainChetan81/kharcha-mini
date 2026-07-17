# kharcha-mini — runbook

Native macOS ingestion step for Kharcha. Reads the owner's iPhone SMS from
`~/Library/Messages/chat.db` (synced via iCloud/Text Message Forwarding), parses
bank transaction alerts with regex, and stores canonical transactions in a local
sqlite db at `~/Desktop/code/kharcha-mini/data/kharcha-mini.db`.

This is step 2 of 4: ingestion + AI proofread (gated OFF by default) +
merchant aliases. No API, no app sync.

## 1. prerequisites

1. **Full Disk Access for `/usr/local/bin/bun`** — System Settings → Privacy &
   Security → Full Disk Access → add `/usr/local/bin/bun`. Without this,
   `sqlite3 ~/Library/Messages/chat.db` returns `authorization denied` and the
   poll will exit cleanly with a log line saying so.
2. **Text Message Forwarding or Messages-in-iCloud** enabled so bank SMS appear
   in the Mac's Messages database.
3. **Real DLT sender IDs** (e.g. `HDFCBK`, `AXISBK`-style headers) collected
   from the owner's actual SMS inbox. These are not in any codebase and must be
   seeded manually (see section 3).

## 2. install

```bash
cd ~/Desktop/code/kharcha-mini
bun install
bash launchd/install.sh
```

The install script copies the LaunchAgent plist to
`~/Library/LaunchAgents/com.chetan.kharcha-mini-ingest.plist`, loads it, and
kickstarts the job.

## 3. seed the sender allowlist

After FDA is granted and at least one forwarded bank SMS is visible in
`~/Library/Messages/chat.db`, collect the core bank DLT codes and run:

```bash
cd ~/Desktop/code/kharcha-mini
bun run seed:allowlist HDFCBK "HDFC Bank" hdfc AXISBK "Axis Bank" axis
```

Arguments are pairs or triples: `bank_code bank_name [parser_key]`. Supported
parser keys today are `axis`, `hdfc`, `indusind`. Senders without a parser key
are still read from chat.db and stored with `parsed_by: failed` for a future
AI-proofread step.

**Important:** store only the stable core bank code, not every variant. Real
forwarded SMS sender IDs are wrapped by carrier prefixes and Apple's
SMS-forwarding relay suffixes. For example, Axis Bank alone appears as
`AXISBK-S(smsft_fi)`, `AXISBK-S(smsft)`, `AXISBK-S(smsft_rm)`,
`AXISBK-T(smsft)`, `AX-AXISBK-S`, `AD-AXISBK-S`, `CP-AXISBK-S`, `JX-AXISBK-S`,
`JK-AXISBK-S`, `JD-AXISBK-S`. HDFC appears similarly as `HDFCBK-S(smsft)`,
`HDFCBK-S(smsft_fi)`, `HDFCBK-S(smsft_rm)`. Every variant contains the literal
bank DLT code (`AXISBK`, `HDFCBK`) as a substring, so seeding `AXISBK` or
`HDFCBK` matches all of them via substring containment. A non-bank sender such
as `SWIGGY-S(smsft_or)` will not match a bank entry.

## 4. operate

- status: `launchctl print gui/$(id -u)/com.chetan.kharcha-mini-ingest | grep state`
- logs: `~/Library/Logs/kharcha-mini-ingest.log` and `.err.log`
- restart / test launchd path: `launchctl kickstart -k gui/$(id -u)/com.chetan.kharcha-mini-ingest`
- manual poll (does not test the launchd environment):
  `bun run ingest` or `bun run src/ingest/run.ts`
- db inspection: `sqlite3 ~/Desktop/code/kharcha-mini/data/kharcha-mini.db`

## 5. kuma heartbeat

Add a Push monitor in Uptime Kuma (`http://mini:3001`) named
`kharcha-mini-ingest`. Copy its push URL into `~/scripts/kuma_push.conf`:

```
kharcha-mini-ingest=http://127.0.0.1:3001/api/push/TOKEN?status=up&msg=OK&ping=
```

The poll script calls `bash ~/scripts/kuma_push.sh kharcha-mini-ingest` after
every run. If the monitor isn't configured yet, the script logs a skip and exits
0.

**Important:** one heartbeat only proves the job *ran*. Detecting a silent
zero-new-transactions stretch (e.g. iCloud sync stopped) needs a second signal
beyond job-liveness. That is a later step; this runbook will be updated when it
lands.

## 6. parser coverage + AI proofread gate

| bank | parser key | status |
|---|---|---|
| Axis Bank | `axis` | ported from Gmail parser + ref no |
| HDFC Bank | `hdfc` | ported from Gmail parser + ref no |
| IndusInd Bank | `indusind` | ported from Gmail parser + ref no |
| all others | — | regex fails; an OpenRouter proofread pass can fill the gap when enabled |

The OpenRouter proofread step is implemented but **disabled by default**. It is
triggered for allowlisted senders when:

- regex parsing failed entirely (`parsed_by: failed`), or
- regex matched but the merchant is a generic placeholder such as
  `UPI Payment`, `Credit`, `Credit Card Payment`, `Card Payment`,
  `HDFC Card Payment`, `HDFC Credit`, `IMPS Credit`, or `Payment`, or
- an amount was extracted but merchant is empty/null.

The gate is controlled by the `openrouter_proofread_enabled` config key.

- check status: `bun run toggle-proofread status`
- enable: `bun run toggle-proofread on`
- disable: `bun run toggle-proofread off`
- or direct sqlite:
  ```bash
  sqlite3 ~/Desktop/code/kharcha-mini/data/kharcha-mini.db \
    "INSERT OR REPLACE INTO config (key,value) VALUES ('openrouter_proofread_enabled','true');"
  ```

**Do not enable until step 1 has produced sane real-world parse results.** The
"low confidence" heuristic is an informed guess and needs validation against
actual bank SMS. Once enabled, the next poll cycle may issue live OpenRouter
calls.

Model is hardcoded to `google/gemini-3.5-flash` via OpenRouter. The API key is
read at runtime from `~/.hermes/.env` (`OPENROUTER_API_KEY`); it is never
written into this repo or logged.

## 7. merchant aliases

The `merchant_aliases` table makes a merchant corrected once (by AI or manually)
resolve instantly the next time the regex emits the same raw merchant string.

| column | notes |
|---|---|
| `raw_pattern` | normalized merchant string: uppercased, punctuation stripped, trailing transaction codes stripped |
| `canonical_merchant` | the corrected/display merchant name |
| `category` | optional category override |
| `source` | `auto` (from OpenRouter) or `manual` (owner correction) |
| `hit_count` | incremented on every successful exact-match lookup |

Matching is **exact only** on the normalized `raw_pattern`. There is no fuzzy
matching, no vector store, and no substring search. To add a manual correction:

```bash
sqlite3 ~/Desktop/code/kharcha-mini/data/kharcha-mini.db <<'SQL'
INSERT OR REPLACE INTO merchant_aliases
  (raw_pattern, canonical_merchant, category, source, hit_count)
VALUES
  ('UPI PAYMENT', 'Swiggy', 'Food', 'manual', 0);
SQL
```

## 8. schema notes

- `source_message_guid` is the only unique constraint and the sole hard dedup
  guarantee.
- `fingerprint` is indexed but **not unique** — same-amount, same-minute
  transactions are legitimate and must not collide.
- `merchant_canonical` exists but is unused until a later step.
- `sync_status` is `pending` until a future app sync step consumes the row.
- `parsed_by` is `regex`, `openrouter`, or `failed`.
- `merchant_aliases` provides exact-match merchant normalization and is
  consulted before any OpenRouter call.

## 9. known limits / gotchas

- The first poll cursor starts at `0`, so any SMS already in chat.db before FDA
  was granted will be recovered.
- The cursor advances per successfully-committed row, not per batch. A single
  bad message is logged and skipped; it does not block newer messages forever.
- Modern macOS sometimes leaves `message.text` NULL and stores content only in
  `message.attributedBody`. The reader includes a best-effort attributedBody
  fallback, but verify with real rows once FDA is granted.
- Forwarded SMS is assumed to have `service IN ('SMS','RCS')`. If the relay tags
  it differently, the allowlist filter returns zero rows with no error.
- Live testing against chat.db is impossible until FDA is granted; typechecking
  and dry runs can still be done with `bun run typecheck` and `bun run ingest`
  (the latter will fail at the DB open step without FDA).
- OpenRouter proofread has been synthetically tested with the gate OFF. A real
  live OpenRouter request can only be validated by the owner after flipping
  `openrouter_proofread_enabled` on and watching one real poll cycle.

## 10. backup

Back up `~/Desktop/code/kharcha-mini/data/kharcha-mini.db` (and `-wal`/`-shm` if
present). The schema is idempotent on first run, but the transaction data is
not.

## 11. API access (step 3)

A small `Bun.serve()` API runs on `127.0.0.1:8300`. It is intentionally **not**
exposed to the internet by default; see the manual tailnet steps below when you
are ready.

### 11.1 endpoints

| method | path | auth | description |
|---|---|---|---|
| GET | `/health` | none | `{ok: true, lastPollAt}` for Uptime Kuma |
| GET | `/transactions?since=<id>&limit=<n>` | Bearer | transactions with `id > since`, ordered by id, default limit 200, max 1000 |
| POST | `/transactions` | Bearer | insert a manual transaction |
| PATCH | `/transactions/:id` | Bearer | update merchant/category/amount/etc.; merchant changes write a `manual` alias |
| GET | `/sync/status` | Bearer | `{cursor, lastPollAt, addedSinceLastCheck}` |
| GET | `/digest/today` | Bearer | `{transactionCount, totalSpend, reviewCount, since}` |

### 11.2 bearer token

The token lives in the macOS Keychain:

- service: `kharcha-mini-api-token`
- account: `mini`

Generate/rotate it with:

```bash
cd ~/Desktop/code/kharcha-mini
bun run generate-api-token
```

Verify it exists (value not shown):

```bash
security find-generic-password -s kharcha-mini-api-token -a mini
```

Use it as `Authorization: Bearer <token>` in every request except `/health`.

### 11.3 run the API manually

```bash
cd ~/Desktop/code/kharcha-mini
bun run api
```

Logs are written to stdout/stderr. For persistence, install the LaunchAgent
(next section).

### 11.4 install the LaunchAgent (manual step — not run automatically)

When you are ready to keep the API running:

```bash
cd ~/Desktop/code/kharcha-mini
bash launchd/install-api.sh
```

This installs `com.chetan.kharcha-mini-api` as a `KeepAlive` LaunchAgent and
kickstarts it. It was **not** installed automatically during this build.

Status and restart:

```bash
launchctl print gui/$(id -u)/com.chetan.kharcha-mini-api | grep state
launchctl kickstart -k gui/$(id -u)/com.chetan.kharcha-mini-api
```

### 11.5 expose on tailnet (manual step — never funnel)

To reach the API from the phone app over Tailscale, run exactly this and verify
with `tailscale serve status`:

```bash
tailscale serve --bg --https=8300 http://127.0.0.1:8300
```

**Never** use `tailscale funnel` for port 8300. The API is intentionally
tailnet-only. A draft net-watchdog addition to clear a forbidden funnel rule is
provided for review (see section 11.7).

### 11.6 Telegram daily digest (Hermes cron — draft for review)

A script-based Hermes cron job is drafted to call `/digest/today` and deliver a
formatted message. It is **not** installed automatically.

Files to review:

- `scripts/digest-telegram.sh` — reads the API token from Keychain, curls the
  endpoint, prints a Telegram-ready message to stdout.
- `scripts/hermes-digest-job.json` — proposed `no_agent: true` Hermes job entry
  that runs the script at `0 21 * * *` and delivers to Telegram.

Apply only after reviewing: copy the JSON object into `~/.hermes/cron/jobs.json`
under the `jobs` array and reload Hermes cron. Do not edit Hermes files blindly.

### 11.7 net-watchdog rule (draft for review)

`scripts/net-watchdog-kharcha-mini.diff` proposes adding a check to
`~/scripts/net-watchdog.sh` that clears any `tailscale funnel` rule on port 8300,
matching the existing forbidden-serve-rule pattern. Apply the diff manually only
after review.
