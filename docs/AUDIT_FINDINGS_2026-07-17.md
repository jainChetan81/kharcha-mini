# Kharcha mini — historical parse audit, 2026-07-17

Ran a read-only re-parse of the mini's canonical `transactions` table (1,761 rows)
against a v3-candidate AI prompt (currency-aware, AutoPay-aware, investment-aware,
canonical category vocabulary — see `docs/V3_SPEC.md`). Script: `scripts/audit-reparse.ts`.
Full machine-readable output: `data/audit-report.json`.

## Run was cut short — OpenRouter account ran out of credits

The account (`~/.hermes/.env` `OPENROUTER_API_KEY`) had **$70 total credits, $52.39
already spent** before this audit started (from live mini ingestion + earlier
proofread runs). The audit itself burned the remaining ~$17.6 and hit **`402
Insufficient credits`** after **143 of 1,761 rows** (8%).

**Root cause of the high per-call cost:** `google/gemini-3.5-flash` on OpenRouter —
the exact model `src/ingest/openrouter.ts` uses for live proofreading — is a
**mandatory-reasoning model**. `reasoning.max_tokens: 0` is rejected outright
("Reasoning is mandatory for this endpoint and cannot be disabled"), and reasoning
tokens bill at the *completion* rate (~$0.0045–0.009/1K tokens). A trivial
single-sentence SMS extraction task was measured burning enough reasoning tokens
to cost **~$0.12/call** — two orders of magnitude more than a comparable
non-reasoning-forced flash model would cost for the same task. This is not an
audit-only problem: **every live OpenRouter proofread call in production pays this
same reasoning tax today.**

Also found and fixed mid-run: the model's default provider route
(`Google AI Studio`) has a **free-tier cap of 5 requests/minute**, which any
concurrency > ~1 blows through immediately (429 → cascading 402s about
"insufficient credits for requested max_tokens", which is a red herring — the real
issue is the rate limit forcing token-budget renegotiation). Fix applied in the
audit script: `provider: { ignore: ["Google AI Studio"] }` forces the paid Vertex
route. **This same pin should go into `src/ingest/openrouter.ts` regardless of the
v3 migration** — it's a one-line fix for a live reliability bug (proofread calls
that 429 today are presumably silently falling back to the regex result via the
existing catch-all in `proofread.ts:201-207`, which explains any anecdotal
"openrouter proofread doesn't seem to fire" reports).

**Action needed before any full re-parse (audit or historical repair, per
V3_SPEC §6) can run:** top up OpenRouter credits. Recommend also evaluating a
non-reasoning-forced model (e.g. a Flash variant without mandatory thinking, or
capping `reasoning.effort: "minimal"` if the model supports it) before committing
to `gemini-3.5-flash` as the v3 pipeline's primary model — the cost profile
observed here (~$0.12/call) at even 20-40 SMS/day would run ~$72-144/month, which
contradicts V3_SPEC's non-goal of "real-time FX rates... openrouter is fine at
this volume; fractions of a cent" assumption.

## Findings from the 143 rows that did complete (45% had at least one issue)

| Issue | Count (of 143) | Severity |
|---|---|---|
| `category_mismatch` | 39 | medium — mostly "Other" → correct category |
| `recoverable_other_category` | 29 | medium — subset of above, quantifies the "Other" pileup |
| `recoverable_generic_merchant` | 13 | medium — "Unknown"/"Card Payment" → real merchant |
| `false_positive_non_transaction` | 9 | **high — real money bug, see below** |
| `recoverable_failed_parse` | 6 | medium — `parsed_by: 'failed'` rows AI could actually parse |
| `amount_mismatch` | 6 | high — all 6 are `recoverable_failed_parse` overlap (amount stored as 0) |
| `foreign_currency_stored_as_inr` | 2 | **high — exact bug the user flagged (USD stored as INR)** |
| `type_mismatch` | 2 | low — NACH/mutual-fund debits should be `investment`, stored `expense` |
| `date_mismatch` | 2 | low — same 2 NACH rows, date extraction also off |

Extrapolated to the full 1,761-row table at the same 45% hit rate: **~790 rows
likely have at least one issue**, concentrated in category/merchant cleanup
(cheap to fix) plus a smaller but real set of financial-correctness bugs (below).

### 1. Confirmed: OTP messages parsed and stored as real transactions (double-counted spend)

**167 rows** in the current canonical table have `raw_text` starting with `OTP is
<code> for txn of INR <amount> at <merchant> on HDFC Bank card ending 2047` —
these are one-time-passwords for a pending transaction, not the transaction
itself. Every sampled OTP row has an amount that exactly matches a same-day
transaction stored separately (the real "Spent Rs.X..." SMS that arrived
moments later) — **confirmed double-counted spend, total ₹56,738 across the 167
rows** (`sqlite3 data/kharcha-mini.db "select round(sum(amount),2), count(*) from
transactions where raw_text like '%OTP%' and amount>0"`).

Good news: **this is not a live bug.** `src/parsers/hdfc.ts:54-61`
(`isHdfcNonTransactionNotice`) already rejects this exact OTP pattern today —
verified by feeding a live-format OTP string straight through
`parseMessage("hdfc", text)`, which correctly returns `parsed: null, parsedBy:
"failed"`. The 167 bad rows are **residue from before the guard existed**
(spread March–July 2026 by `date`, but all `created_at: (datetime('now'))` —
i.e. inserted by a since-fixed parser version, or backfilled). This needs a
one-time cleanup pass (tombstone via `deleted_at`, per V3_SPEC's repair-pass
design — do not hard-delete, the `source_message_guid` unique constraint must
keep blocking re-ingestion), not a code fix. Axis has an equivalent OTP guard in
`src/parsers/axis.ts` — worth spot-checking whether Axis OTPs slipped through in
an earlier window too (not sampled in this 143-row batch).

### 2. Confirmed: foreign-currency subscription charges stored as if INR (exact user-reported bug)

Two rows found in the sample, matching the user's report verbatim:

- id 2: `Spent ... USD 8 ... T3 CHAT` → stored `amount: 8` (implying ₹8, actually $8 ≈ ₹700)
- id 55: `Spent ... USD 23.6 ... CLAUDE*AI S` → stored `amount: 23.6` (implying ₹23.6, actually $23.6 ≈ ₹2075)

Both are `parsed_by: 'regex'` — the **regex parser itself extracts the numeric
amount with no currency awareness**; OpenRouter proofread never fires because
regex "succeeded" (has a merchant, non-generic). This means the fix must be
either (a) regex-side: detect `USD|EUR|GBP` in the same line as the amount and
force a proofread trigger even when regex "succeeds", or (b) pipeline-side: the
v3 AI-first inversion (regex runs but never decides alone) — which V3_SPEC
already proposes. Given the OpenRouterInc/AutoPay examples the user pasted
manually (rows 1738-1760 in the live table, `parsed_by: 'manual'`, all stored as
flat `₹1000`/`₹26.38` placeholders because the on-device Gemini/manual path hit
the same currency-blindness), this is not an isolated case — **every USD-billed
subscription on this card (OpenRouter, Claude, T3 Chat, and likely others) is
affected.**

### 3. Confirmed: "upcoming AutoPay" pre-debit notices treated as real transactions

Not found in the mini's regex-parsed rows in this sample (HDFC/Axis regex guards
already reject these — see `isHdfcNonTransactionNotice`, `isAxisNonTransactionNotice`),
but confirmed via the **app-pushed manual rows** the user referenced:
`kharcha-mini.db` ids 1739, 1744, 1756, 1758, 1760 — all `raw_text` starting
`"Here's the summary of your upcoming AutoPay transaction ... To be debited
by: <future date>"`, all inserted as real `expense` transactions with
`parsed_by: 'manual'` (bypasses every guard because manual entries skip the
parser entirely). These are exactly the "AutoPay ghosts" V3_SPEC's risk section
already anticipates, arriving via a path (manual entry / app push) the guard
logic doesn't cover. Confirms V3_SPEC's plan to give the AI layer (not
regex-only) the authority to reject these is necessary — and additionally
suggests the **manual-entry / paste-sheet path also needs the same is_transaction
gate** applied before persisting, not just the SMS ingestion path.

### 4. Confirmed: "Other" category pileup, and why

29/143 rows (20%) stored as `category: 'Other'` had an obvious better category —
Food (cafes, Swiggy, food delivery UPI merchants), Entertainment (DAZN, YouTube,
Netflix), Shopping (Amazon), etc. Root cause is exactly what V2's known-follow-up
already flagged: regex extracts a raw merchant string with no category
inference, and OpenRouter proofread only fires on `failed`/generic-placeholder
merchants — a regex parse that gets a *specific* but unrecognized merchant
string (e.g. "MUNCHMART TECHNOLOG", "CAFE AMUDHAM") never gets categorized at
all, it just inherits whatever default the insert path uses. Matches the
`select category, count(*)` from the live db: `Other=1124` of 1774 total (see
prior exploration).

### 5. One person-name-merchant edge case worth deciding, not fixing blindly

Recurring UPI transfers to `"RAVINDRA KUMAR YADA(V)"` are currently categorized
`Food` (9 occurrences in this sample alone) via an existing `merchant_aliases`
entry — almost certainly a tiffin/food vendor paid by UPI. The v3-candidate
prompt, run **without alias context**, recategorized all 9 to `Other` (a person's
name gives the LLM no category signal on its own). **This is not a bug in the
audit's stored data — it's a demonstration that V3_SPEC's design decision to
inject alias context into the AI prompt (step 4 of the pipeline) is load-bearing,
not optional polish.** Any reparse/repair pass that calls the AI without alias
context will silently regress well-categorized person-name merchants. Same
pattern for "CTRLX TECHNOLOGIES" (id 1092, currently `Food`, likely a specific
known vendor).

### 6. `investment` type: 2 confirmed cases, likely underdetects mutual fund debits

Two NACH debits to "INDIAN CLEARING CORP" (mutual fund/SIP clearing house) are
stored as `type: 'expense'`, `category` unset — v3 correctly flagged both as
`type: 'investment'`. The mini schema already supports `investment` as a type
(`src/db/schema.ts:13`) but nothing currently classifies into it — matches
V3_SPEC's plan. Also both rows have a **date bug**: v3 returned `2026-07-17`
(today, the placeholder) instead of the actual message date, because these
`raw_text` values have no date in them — the message's date must come from the
SMS's own metadata (`chat.db` received timestamp), not be inferred by the AI
from message content. This is a script-side gap in the *audit*, not necessarily
a pipeline gap (`chatdb-reader.ts` presumably has the real received-at
timestamp available at ingest time, unlike this after-the-fact audit which only
has `raw_text`) — worth confirming the live ingest pipeline uses the SMS
timestamp as the date source-of-truth rather than only AI-extracted date.

### 7. 6 `parsed_by: 'failed'` rows the AI could recover

Includes two large NEFT credits (₹379,009 and ₹266,462) and a ₹1,525,000 mobile
banking debit, all currently sitting as `amount: 0, merchant: 'Unknown'` in the
canonical table — real money, completely unaccounted for in any insights/totals
today. v3 recovered all of them with `confidence: 'high'`. One merchant name
came out as literal `"HACK"` (a garbled substring artifact from
`NEFT/CMS.../H...` truncation, not an AI hallucination — the raw text was cut at
300 chars in the audit's snippet; worth re-checking on the full message before
trusting that merchant name for the real repair pass).

## Recommended next steps (not yet done)

1. **Top up OpenRouter credits** — nothing else here can run at scale until this is resolved. Current balance: $0.
2. **Apply the `provider: { ignore: ["Google AI Studio"] }` pin** to `src/ingest/openrouter.ts` immediately — independent of any other change, fixes a live reliability bug.
3. ~~**Re-run the full audit** (`bun run scripts/audit-reparse.ts`) once credits are available~~ — **superseded**: a full-coverage Claude audit of all 1,623 SMS-derived rows completed the same evening (see next section). Real counts now exist; the OpenRouter re-run is only needed as a spot-check on the eventual replacement model, not for coverage.
4. **Decide on model/cost** before committing `gemini-3.5-flash` as the v3 pipeline's primary model — the observed ~$0.12/call reasoning tax contradicts the "fractions of a cent" cost assumption in `docs/V3_SPEC.md`.
5. **OTP cleanup pass** (167+ rows, ₹56,738) — tombstone via `deleted_at`, do not hard-delete (`source_message_guid` must keep blocking re-ingestion). Spot-check Axis for the same historical residue.
6. Feed all of the above into the prompt rewrite (see companion changes to `src/ingest/openrouter.ts` and the app's `lib/gemini/client.ts` in this session) and into `docs/V3_SPEC.md` phase planning.

---

# Full-coverage Claude audit — same day, all rows (evening addendum)

The 143-row OpenRouter sample above was cut short by credits. A second audit ran
the same evening with Claude reviewing **every SMS-derived row individually**
(1,623 rows: 1,214 regex + 10 openrouter + 399 failed — snapshot taken just
before the app-history backfill added the `manual` rows). Machine-readable
output: `data/audit-findings-full-2026-07-17.json` (per-row issue codes +
suggested corrections — this file can drive the phase 4 repair pass directly).

**696 of 1,623 rows (43%) have at least one issue** — independently confirming
the 45% extrapolation above with real counts.

| Issue | Rows | Financial impact |
|---|---|---|
| WRONG_CATEGORY | 353 | insights noise — suggested fixes: Food 130, Home 97, Shopping 42, Entertainment 35, Work 23, Health 11, Transport 10, Sports 4, Utilities 1 |
| NOT_A_TRANSACTION | 195 | see breakdown below |
| WRONG_MERCHANT | 183 | gateway-prefix garbage (see normalization table) |
| MISSED_TRANSACTION | 68 | **₹3,953,343 of real money absent from all totals** |
| WRONG_CURRENCY | 23 | all USD; stored as bare numbers read as INR |

### NOT_A_TRANSACTION breakdown (195 rows)

| Subclass | Rows | Amount | Note |
|---|---|---|---|
| OTP-as-transaction | 166 | ₹56,480 | same population as §1 above (167 incl. one row outside this snapshot) — counts now confirmed, not extrapolated |
| Credit-card bill payment stored as **income** | 7 | ₹132,841 | **new class the sample missed** — "payment received towards your Axis credit card" confirmations parsed as income; they're self-transfers, and several pair with a separately-captured bank debit for the same amount (double count in *both* directions) |
| Misc (statements, balance notices, declined, refund-initiated-only) | 21 | ₹208,048 | individually reviewed, listed in the findings JSON |
| Upcoming-AutoPay via SMS | 1 | ₹21 | confirms §3: the regex guards do hold on the SMS path — the AutoPay ghost problem is almost entirely the manual/paste path |

Total **fake income currently inflating income totals: 9 rows, ₹114,971**
(the cc-bill-payment rows typed `income`, plus two misc credits).

### MISSED_TRANSACTION highlights (68 rows, ₹3.95M)

- **10 salary NEFT credits, ~₹2.66–2.71L each (~₹2.7M total)** — the recurring
  month-end `NEFT/CMS<ref>/HACK` credit. `HACK` is a truncated remitter code
  (per §7's warning, resolve the true employer name from the full message before
  writing an alias). **Salary has never been captured by the pipeline; income
  totals are wrong by lakhs.** These are the same class as §7's two examples —
  the full audit shows it's every month, systematically.
- Cashback/refund credits ("has been credited") the regex ignores.
- The ₹1,525,000 mobile-banking debit and other large one-offs from §7.

### WRONG_MERCHANT — normalization table (183 rows)

Payment-gateway prefixes and legal-entity names dominate; the top mappings are
mechanical and should become `normalizeMerchant()` strip-rules or alias seeds:

| Raw (count) | Canonical |
|---|---|
| `PYU*Swiggy Food` (32), `RAZ*Swiggy` (20), `WWW SWIGGY IN` (9), `PTM*SWIGGY IN` (5), `BUNDL TECHNOLOGIES` (19) | Swiggy |
| `RSP*INSTAMART` (11), `SWIGGY INSTAMART PR` (5) | Swiggy Instamart |
| `YOUTUBEGOOG` (8) | YouTube |
| `CTRLX TECHNOLOGIES` (8) | Swish (known food vendor — keep Food, agrees with §5) |
| `FLIPKART PA` (6) | Flipkart |

Pattern: strip `PYU*`/`RAZ*`/`RSP*`/`PTM*` gateway prefixes before alias lookup;
map legal entities (BUNDL→Swiggy, CTRLX→Swish) via aliases.

### WRONG_CURRENCY (23 rows, all USD)

Full population of §2's two-row sample: OpenRouter, Claude/Anthropic, T3 Chat
and other AI subscriptions — all `parsed_by: regex`, all Work category. Every
one has a suggested `{currency, amount}` correction in the findings JSON.

### Consequence for the repair pass (changes the cost calculus)

The phase 4 repair pass **no longer needs an LLM re-parse of the full table**.
`data/audit-findings-full-2026-07-17.json` already contains a per-row verdict +
suggested correction for every problem row, produced with alias/context
awareness. The repair script can consume it deterministically (tombstones,
currency fixes, merchant/category updates, failed-row recovery) at **zero
marginal LLM cost**, reserving paid calls for future live ingestion and an
optional spot-check sample. This decouples the historical repair entirely from
the model/cost decision and from the credits top-up.
