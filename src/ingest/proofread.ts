import { getConfig } from "../db/config";
import {
  findAlias,
  incrementHitCount,
  normalizeMerchant,
  upsertAlias,
} from "../db/merchant-aliases";
import { isAxisNonTransactionNotice } from "../parsers/axis";
import { isHdfcNonTransactionNotice } from "../parsers/hdfc";
import { type ParsedTransaction, type ParseOutcome } from "../parsers";
import {
  openRouterDateToDbDate,
  proofreadWithOpenRouter,
  type OpenRouterParsedTransaction,
} from "./openrouter";

const PROOFREAD_ENABLED_KEY = "openrouter_proofread_enabled";

// Generic placeholder merchants emitted by the step-1 regex parsers when they
// can't extract a specific counterparty. Keep this in sync with the parsers.
const GENERIC_PLACEHOLDERS = new Set([
  "UPI Payment",
  "Credit",
  "Credit Card Payment",
  "Card Payment",
  "HDFC Card Payment",
  "HDFC Credit",
  "IMPS Credit",
  "Payment",
]);

function isGenericPlaceholder(merchant: string | null | undefined): boolean {
  if (!merchant) return false;
  return GENERIC_PLACEHOLDERS.has(merchant.trim());
}

function isEmptyMerchant(merchant: string | null | undefined): boolean {
  return !merchant || merchant.trim().length === 0;
}

function isNonTransactionNotice(
  body: string,
  bankName: string | null,
): boolean {
  if (bankName === "Axis Bank") return isAxisNonTransactionNotice(body);
  if (bankName === "HDFC Bank") return isHdfcNonTransactionNotice(body);
  return false;
}

function shouldTriggerProofread(outcome: ParseOutcome, rawBody: string): boolean {
  // Non-transaction notices (OTPs, statements, reminders, mandates, etc.) should
  // never be sent to OpenRouter, even if the regex path marked them as failed.
  if (isNonTransactionNotice(rawBody, outcome.bankName)) {
    log("skipped-non-transaction-notice", outcome.bankName);
    return false;
  }

  if (outcome.parsedBy === "failed") return true;
  if (!outcome.parsed) return false;
  const { amount, merchant, currency } = outcome.parsed;
  // Foreign-currency spends always get an AI pass: the regex only sees the
  // foreign number, and the AI layer knows how to separate currency /
  // original_amount / any SMS-stated INR equivalent (2026-07-17 audit:
  // 23 USD rows stored as bare INR numbers).
  if (currency && currency !== "INR") return true;
  if (isGenericPlaceholder(merchant)) return true;
  if (amount !== undefined && amount > 0 && isEmptyMerchant(merchant)) {
    return true;
  }
  return false;
}

function log(...parts: unknown[]): void {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [proofread]`, ...parts);
}

function logError(...parts: unknown[]): void {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.error(`[${ts}] [proofread]`, ...parts);
}

function applyAlias(
  outcome: ParseOutcome,
  alias: { canonicalMerchant: string; category: string | null },
): ParseOutcome {
  return {
    ...outcome,
    parsed: outcome.parsed
      ? {
          ...outcome.parsed,
          merchant: alias.canonicalMerchant,
          category: alias.category ?? outcome.parsed.category ?? "Other",
          confidence: "high",
        }
      : {
          amount: 0,
          merchant: alias.canonicalMerchant,
          date: null,
          type: "expense",
          category: alias.category ?? "Other",
          confidence: "high",
        },
  };
}

function applyOpenRouterResult(
  outcome: ParseOutcome,
  result: OpenRouterParsedTransaction,
): ParseOutcome {
  const date = openRouterDateToDbDate(result.date);
  return {
    ...outcome,
    parsedBy: "openrouter",
    parsed: {
      amount: result.amount,
      merchant: result.merchant ?? outcome.parsed?.merchant ?? "Unknown",
      date,
      type: result.type,
      category: result.category,
      confidence: result.confidence,
      referenceNumber: result.reference_number,
      accountLast4: outcome.parsed?.accountLast4 ?? null,
      isSubscription: outcome.parsed?.isSubscription ?? false,
      billingDay: outcome.parsed?.billingDay ?? null,
      currency: result.currency !== "INR" ? result.currency : undefined,
      originalAmount:
        result.currency !== "INR" ? result.originalAmount : undefined,
      // Amount derived via the fallback FX table (not stated in the SMS) —
      // surface for human review.
      needsReview: result.fxRate !== null,
    },
  };
}

export async function resolveWithProofread(
  rawBody: string,
  bankName: string | null,
  initialOutcome: ParseOutcome,
  messageDate: Date,
): Promise<ParseOutcome> {
  const enabled = (await getConfig(PROOFREAD_ENABLED_KEY)) === "true";

  // 1. Alias lookup always runs: a merchant corrected once should never be
  //    misidentified twice, regardless of whether the AI gate is open.
  if (initialOutcome.parsed?.merchant) {
    const alias = await findAlias(initialOutcome.parsed.merchant);
    if (alias) {
      await incrementHitCount(alias.id);
      log(
        `skipped-via-alias: "${initialOutcome.parsed.merchant}" -> "${alias.canonicalMerchant}"`,
      );
      return applyAlias(initialOutcome, alias);
    }
  }

  // 2. Decide whether the message needs proofreading.
  if (!shouldTriggerProofread(initialOutcome, rawBody)) {
    log("not-triggered");
    return initialOutcome;
  }

  // 3. Trigger condition matched. If the feature is disabled, log the intent
  //    and return the original outcome so usage data can validate the heuristic.
  if (!enabled) {
    log("would-trigger (flag OFF)");
    return initialOutcome;
  }

  // 3b. Look up an alias hint to pass into the AI prompt even when there was
  //     no exact-match short-circuit above (e.g. the regex merchant was a
  //     generic placeholder, so findAlias() on it wouldn't match anything
  //     useful — but a person-name/bare-UPI-handle merchant from an earlier
  //     manually-corrected occurrence might still be relevant context).
  //     Confirmed necessary by the 2026-07-17 audit: a fresh AI call with no
  //     alias context recategorized known recurring person-name merchants
  //     (e.g. a tiffin vendor paid by UPI) from "Food" to "Other".
  const aliasHint = initialOutcome.parsed?.merchant
    ? await findAlias(initialOutcome.parsed.merchant)
    : null;

  // 4. Call OpenRouter.
  log("fired");
  try {
    const partial = {
      amount: initialOutcome.parsed?.amount,
      date: initialOutcome.parsed?.date,
    };
    const result = await proofreadWithOpenRouter({
      rawBody,
      bankName,
      partial,
      messageDate,
      aliasHint: aliasHint
        ? {
            canonicalMerchant: aliasHint.canonicalMerchant,
            category: aliasHint.category,
          }
        : null,
    });

    if (!result.parsed) {
      logError("openrouter failed:", result.errorMessage ?? result.error);
      return initialOutcome;
    }

    // 5. If OpenRouter classifies this as a non-transaction notice, treat it as
    //    a no-op rather than persisting a fabricated transaction.
    if (result.parsed.is_transaction === false) {
      log("skipped-non-transaction-openrouter");
      return initialOutcome;
    }

    // 6. Persist the merchant as an auto alias so future identical regex
    //    placeholders resolve instantly. The raw_pattern should be the merchant
    //    the regex produced (e.g. "UPI Payment"), not the AI-corrected one, so
    //    the next identical regex hit matches.
    if (result.parsed.merchant) {
      await upsertAlias({
        rawMerchant: initialOutcome.parsed?.merchant ?? result.parsed.merchant,
        canonicalMerchant: result.parsed.merchant,
        category: result.parsed.category,
        source: "auto",
      });
    }

    return applyOpenRouterResult(initialOutcome, result.parsed);
  } catch (err) {
    logError(
      "openrouter threw:",
      err instanceof Error ? err.message : String(err),
    );
    return initialOutcome;
  }
}

export { GENERIC_PLACEHOLDERS, normalizeMerchant };
