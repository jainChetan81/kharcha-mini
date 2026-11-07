export interface CardBillRow {
  merchant: string;
  deletedAt: string | null;
  rawText?: string | null;
}

// Card-bill receipts are named "<Bank> Credit Card" by the parsers; bank debits keep the payee (CRED Club, ...).
// When rawText is available, receipt vs bank debit can also be distinguished for auto-debits that share the
// "<Bank> Credit Card" merchant name.
const isReceipt = (row: CardBillRow | string, currentRawText?: string | null): boolean => {
  const merchant = typeof row === "string" ? row : row.merchant;
  const text = typeof row === "string" ? currentRawText : (row.rawText ?? currentRawText);
  if (text) {
    if (/(?:received\s+towards|credited\s+to\s+your\s+card)/i.test(text)) return true;
    if (/(?:^Debit\s+INR|debited|CreditCard\s+Payment)/i.test(text)) return false;
  }
  return /Credit Card$/.test(merchant);
};

/**
 * True when this card-bill row is the second side of a payment already stored: an unpaired
 * live row of the opposite side (debit vs receipt) with the same amount nearby. `near` holds
 * same-amount Credit Card Payment rows within the window, tombstones included.
 */
export function pairsWithCardBill(
  near: CardBillRow[],
  merchant: string,
  rawText?: string | null,
): boolean {
  const receipt = isReceipt(merchant, rawText);
  const opposite = near.filter((r) => !r.deletedAt && isReceipt(r) !== receipt).length;
  const alreadyPaired = near.filter((r) => r.deletedAt && isReceipt(r) === receipt).length;
  return opposite > alreadyPaired;
}

/** Card statement or due notice: no money moved, but it names the bill and due date. */
export const isCardBillNotice = (text: string): boolean =>
  /Payment of INR [\d,.]+ for Axis Bank Credit Card .*due on|Amount Due Rs\.?\s*[\d,.]+ on HDFC Bank Credit Card|Statement: Total due|^\s*Statement Generated/is.test(text);
