/**
 * The staging allow-list (M1-18): a comma-separated list of full addresses
 * and `@domain` entries. Matching ignores case. An empty list allows nothing.
 */
export interface AllowList {
  readonly addresses: ReadonlySet<string>;
  readonly domains: ReadonlySet<string>;
}

export function parseAllowList(text: string): AllowList {
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const raw of text.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith("@")) domains.add(entry.slice(1));
    else addresses.add(entry);
  }
  return { addresses, domains };
}

export function isAllowed(list: AllowList | null, address: string): boolean {
  if (list === null) return true;
  const normalized = address.trim().toLowerCase();
  if (list.addresses.has(normalized)) return true;
  const at = normalized.lastIndexOf("@");
  return at >= 0 && list.domains.has(normalized.slice(at + 1));
}

export class EmailRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailRefusedError";
  }
}

/** Throws when the address is outside the list. The message never repeats the address in full. */
export function assertAllowed(list: AllowList | null, address: string): void {
  if (isAllowed(list, address)) return;
  const at = address.lastIndexOf("@");
  const domain = at >= 0 ? address.slice(at + 1) : "?";
  throw new EmailRefusedError(
    `refused: an address at ${domain} is outside the staging allow-list (EMAIL_ALLOW_LIST)`,
  );
}
