/**
 * A check's number as staff, tickets and receipts show it (M7-03): live
 * checks by their number ("1042"), practice checks from training mode with
 * T- and four digits from their own counter ("T-0012").
 */
export function trainingNumber(n: number): string {
  return `T-${String(n).padStart(4, "0")}`;
}

export function checkNumberLabel(n: number, training = false): string {
  return training ? trainingNumber(n) : String(n);
}
