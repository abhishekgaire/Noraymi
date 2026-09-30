import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Nothing outside the database is called inside a database transaction
 * (spec 01). withVenue and withOrgScope mark their transaction here, and the
 * Stripe and Twilio clients call assertOutsideTransaction() before every call.
 */
const transactionScope = new AsyncLocalStorage<{ readonly label: string }>();

export function runInTransactionScope<T>(label: string, work: () => Promise<T>): Promise<T> {
  return transactionScope.run({ label }, work);
}

export function inTransaction(): boolean {
  return transactionScope.getStore() !== undefined;
}

export class OutsideCallInTransactionError extends Error {
  constructor(service: string, label: string) {
    super(
      `refusing to call ${service} inside an open database transaction (${label}); finish the transaction first`,
    );
    this.name = "OutsideCallInTransactionError";
  }
}

export function assertOutsideTransaction(service: string): void {
  const store = transactionScope.getStore();
  if (store) throw new OutsideCallInTransactionError(service, store.label);
}
