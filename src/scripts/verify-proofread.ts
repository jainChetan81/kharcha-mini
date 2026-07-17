import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";
import { ensureSchema } from "../db/bootstrap";
import { getConfig, setConfig } from "../db/config";
import { db } from "../db/connection";
import { merchantAliases } from "../db/schema";
import { findAlias, normalizeMerchant, upsertAlias } from "../db/merchant-aliases";
import { parseMessage } from "../parsers";
import { resolveWithProofread } from "../ingest/proofread";
import type { OpenRouterParseResult } from "../ingest/openrouter";

const KEY = "openrouter_proofread_enabled";

function fail(message: string): never {
  // eslint-disable-next-line no-console
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

async function main(): Promise<void> {
  // Point at a temporary DB so the verification is isolated and repeatable.
  const tmpDir = mkdtempSync(join(tmpdir(), "kharcha-mini-verify-"));
  const dbPath = join(tmpDir, "test.db");
  process.env.KHARCHA_MINI_DB = dbPath;

  try {
    ensureSchema();

    // 1. Confirm the flag defaults OFF.
    const enabled = await getConfig(KEY);
    assert(enabled === null || enabled === "false", `expected flag OFF by default, got ${enabled ?? "<unset>"}`);
    // eslint-disable-next-line no-console
    console.log(`OK: ${KEY} defaults OFF (${enabled ?? "unset"})`);

    // 2. Alias exact-match lookup and hit_count increment.
    await upsertAlias({
      rawMerchant: "UPI Payment",
      canonicalMerchant: "Swiggy",
      category: "Food",
      source: "manual",
    });

    const aliasBefore = await findAlias("UPI Payment");
    assert(aliasBefore !== null, "alias should exist after upsert");
    assert(aliasBefore.canonicalMerchant === "Swiggy", "canonical merchant mismatch");
    const hitsBefore = aliasBefore.hitCount;

    const realMerchantSms =
      "Amount Debited: INR 299.00 Date & Time: 07-04-26, 12:30:00 Transaction Info: UPI/P2M/123456/SWIGGY";
    const initialOutcome = parseMessage("axis", realMerchantSms);
    assert(initialOutcome.parsedBy === "regex", "regex should match the Axis UPI debit template");
    assert(initialOutcome.parsed?.merchant === "SWIGGY", `expected SWIGGY, got ${initialOutcome.parsed?.merchant}`);

    // This message does NOT trigger the generic placeholder path because the
    // regex already extracted a real merchant. Use a message where the regex
    // cannot extract a specific merchant to test alias skip.
    const genericSms =
      "Amount Debited: INR 299.00 Date & Time: 07-04-26, 12:30:00 Transaction Info: UPI/P2M/123456";
    const genericOutcome = parseMessage("axis", genericSms);
    assert(genericOutcome.parsed?.merchant === "UPI Payment", `expected generic UPI Payment, got ${genericOutcome.parsed?.merchant}`);

    const resolved = await resolveWithProofread(genericSms, "Axis Bank", genericOutcome, new Date());
    assert(resolved.parsedBy === "regex", "alias resolution keeps parsedBy=regex");
    assert(resolved.parsed?.merchant === "Swiggy", `expected canonical Swiggy, got ${resolved.parsed?.merchant}`);
    assert(resolved.parsed?.category === "Food", `expected Food category, got ${resolved.parsed?.category}`);
    assert(resolved.parsed?.confidence === "high", `expected high confidence from alias, got ${resolved.parsed?.confidence}`);

    const aliasAfter = await findAlias("UPI Payment");
    assert(aliasAfter !== null, "alias should still exist");
    assert(aliasAfter.hitCount === hitsBefore + 1, `expected hit_count ${hitsBefore + 1}, got ${aliasAfter.hitCount}`);
    // eslint-disable-next-line no-console
    console.log("OK: alias exact-match lookup works and hit_count incremented");

    // 3. Verify normalization is used consistently.
    const normalized = normalizeMerchant("UPI Payment");
    assert(normalized === "UPI PAYMENT", `expected UPI PAYMENT, got ${normalized}`);
    const aliasNormalized = await findAlias("  upi! payment  ");
    assert(aliasNormalized !== null, "normalized lookup should match");
    // eslint-disable-next-line no-console
    console.log("OK: normalizeMerchant used for lookups");

    // 4. Trigger decisions with the flag OFF (no real network call).
    const failedSms = "This is a non-bank promotional message with no amount";
    const failedOutcome = parseMessage("axis", failedSms);
    assert(failedOutcome.parsedBy === "failed", "regex should fail");
    const failedResolved = await resolveWithProofread(failedSms, "Axis Bank", failedOutcome, new Date());
    assert(failedResolved.parsedBy === "failed", "failed stays failed when flag is OFF");
    // eslint-disable-next-line no-console
    console.log("OK: failed regex correctly identified as would-trigger without network call");

    const placeholderSms =
      "Thank you for using your HDFC Bank Credit Card ending 1234 for Rs 999.00 at 123 on 07 Apr, 2026 at 12:30:30";
    const placeholderOutcome = parseMessage("hdfc", placeholderSms);
    assert(placeholderOutcome.parsed?.merchant === "HDFC Card Payment", `expected generic HDFC Card Payment, got ${placeholderOutcome.parsed?.merchant}`);
    const placeholderResolved = await resolveWithProofread(placeholderSms, "HDFC Bank", placeholderOutcome, new Date());
    assert(placeholderResolved.parsedBy === "regex", "placeholder stays regex when flag is OFF");
    // eslint-disable-next-line no-console
    console.log("OK: generic placeholder correctly identified as would-trigger without network call");

    // 5. Non-transaction guards must skip proofreading even when the flag is ON.
    //    These assertions should never reach the network because the guard runs
    //    before any OpenRouter call.
    await setConfig(KEY, "true");
    const enabledOn = await getConfig(KEY);
    assert(enabledOn === "true", "flag should be ON for guard tests");

    const axisOtpSms =
      "Dear Cardholder, 246071 is SECRET OTP for txn of INR 0.00 on Axis Bank card ending 1234. Valid for 10 mins.";
    const axisOtpOutcome = parseMessage("axis", axisOtpSms);
    assert(axisOtpOutcome.parsedBy === "failed", "regex should fail the OTP message");
    const axisOtpResolved = await resolveWithProofread(axisOtpSms, "Axis Bank", axisOtpOutcome, new Date());
    assert(axisOtpResolved.parsedBy === "failed", "OTP should stay failed, not go to openrouter");
    // eslint-disable-next-line no-console
    console.log("OK: Axis OTP skipped proofreading with flag ON (no network call)");

    const axisMandateSms =
      "E-mandate registration for Netflix has been registered on your Axis Bank A/c XX1234. INR 199 will be debited on approval.";
    const axisMandateOutcome = parseMessage("axis", axisMandateSms);
    assert(axisMandateOutcome.parsedBy === "failed", "regex should fail the e-mandate message");
    const axisMandateResolved = await resolveWithProofread(axisMandateSms, "Axis Bank", axisMandateOutcome, new Date());
    assert(axisMandateResolved.parsedBy === "failed", "e-mandate should stay failed, not go to openrouter");
    // eslint-disable-next-line no-console
    console.log("OK: Axis e-mandate skipped proofreading with flag ON (no network call)");

    const hdfcStatementSms =
      "HDFC Bank Credit Card XX2047 Statement: Total due: Rs.29,600.00 Min.due: Rs.1,972.00 Pay by 21-03-2026";
    const hdfcStatementOutcome = parseMessage("hdfc", hdfcStatementSms);
    assert(hdfcStatementOutcome.parsedBy === "failed", "regex should fail the statement message");
    const hdfcStatementResolved = await resolveWithProofread(hdfcStatementSms, "HDFC Bank", hdfcStatementOutcome, new Date());
    assert(hdfcStatementResolved.parsedBy === "failed", "statement should stay failed, not go to openrouter");
    // eslint-disable-next-line no-console
    console.log("OK: HDFC statement skipped proofreading with flag ON (no network call)");

    await setConfig(KEY, "false");

    // 6. A message that is not a known notice and that regex cannot parse should
    //    still reach the "would trigger" state when the flag is OFF.
    const garbledSms =
      "Txn alert: your Axis Bank card was charged INR 349 at some-merchant on 07-04-26. Ref ABC123.";
    const garbledOutcome = parseMessage("axis", garbledSms);
    assert(garbledOutcome.parsedBy === "failed", "regex should fail the garbled transaction");
    const garbledResolved = await resolveWithProofread(garbledSms, "Axis Bank", garbledOutcome, new Date());
    assert(garbledResolved.parsedBy === "failed", "garbled transaction stays failed when flag is OFF");
    // eslint-disable-next-line no-console
    console.log("OK: garbled transaction still reaches would-trigger state");

    // 7. OpenRouter safety net: if the guard somehow misses a non-transaction,
    //    an is_transaction: false response must be treated as a no-op.
    const nonTransactionResult: OpenRouterParseResult = {
      parsed: {
        amount: 0,
        merchant: null,
        category: "Other",
        type: "expense",
        date: "2026-07-14",
        confidence: "low",
        reference_number: null,
        is_transaction: false,
        currency: "INR",
        originalAmount: 0,
        fxRate: null,
      },
      raw: JSON.stringify({ is_transaction: false }),
    };
    mock.module("../ingest/openrouter", () => ({
      proofreadWithOpenRouter: async () => nonTransactionResult,
      openRouterDateToDbDate: (date: string) => `${date} 00:00`,
      OPENROUTER_MODEL: "mock",
      DEFAULT_CATEGORIES: ["Other"],
    }));

    await setConfig(KEY, "true");
    const missedGuardSms =
      "This is a weird notice that no guard catches yet, but OpenRouter should classify it as non-transaction.";
    const missedGuardOutcome = parseMessage("axis", missedGuardSms);
    assert(missedGuardOutcome.parsedBy === "failed", "regex should fail the missed-guard message");
    const missedGuardResolved = await resolveWithProofread(missedGuardSms, "Axis Bank", missedGuardOutcome, new Date());
    assert(missedGuardResolved.parsedBy === "failed", "is_transaction:false should not mutate parsedBy");
    // eslint-disable-next-line no-console
    console.log("OK: OpenRouter is_transaction:false safety net treats response as no-op");

    await setConfig(KEY, "false");

    // 8. Sanity-check DB schema.
    const aliasRows = await db.select().from(merchantAliases).all();
    assert(aliasRows.length >= 1, "merchant_aliases table should have rows");
    // eslint-disable-next-line no-console
    console.log("OK: merchant_aliases table is queryable");

    // eslint-disable-next-line no-console
    console.log("\nAll verification checks passed.");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("verify-proofread failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
