// Card-bill receipts are named "<Bank> Credit Card" by the parsers; bank debits keep the payee (CRED Club, ...).
const isReceipt = (merchant: string) => /Credit Card$/.test(merchant);

/**
 * True when this card-bill row is the second side of a payment already stored: an unpaired
 * live row of the opposite side (debit vs receipt) with the same amount nearby. `near` holds
 * same-amount Credit Card Payment rows within the window, tombstones included.
 */
export function pairsWithCardBill(near: { merchant: string; deletedAt: string | null }[], merchant: string): boolean {
  const receipt = isReceipt(merchant);
  const opposite = near.filter((r) => !r.deletedAt && isReceipt(r.merchant) !== receipt).length;
  const alreadyPaired = near.filter((r) => r.deletedAt && isReceipt(r.merchant) === receipt).length;
  return opposite > alreadyPaired;
}
