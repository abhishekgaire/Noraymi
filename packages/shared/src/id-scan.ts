/**
 * Reading a US or Canadian ID's barcode on the device that scanned it (M2-12;
 * spec 04 · id_checks; spec 12 · 6). The PDF417 code on a driver's licence
 * follows the AAMVA layout: three-letter element ids, each followed by its
 * value. Only the rule pack's four fields come out (name, date of birth, ID
 * number, expiration); the address, height, eye colour and the rest never
 * leave the parser, so they never reach our servers.
 */
export interface IdScanFields {
  readonly name: string;
  /** YYYY-MM-DD */
  readonly dateOfBirth: string;
  readonly idNumber: string;
  /** YYYY-MM-DD */
  readonly expiration: string;
}

export const ID_SCAN_FIELDS = ["name", "dateOfBirth", "idNumber", "expiration"] as const;

const ELEMENT = /^(D[A-Z]{2})(.*)$/;
/** Lines end with a newline, a carriage return or the record separator (character 30) AAMVA uses. */
const LINE_BREAKS = new RegExp(`[\\r\\n${String.fromCharCode(30)}]+`);

/** AAMVA dates are MMDDCCYY in the US and CCYYMMDD in Canada; both read as YYYY-MM-DD. */
function aamvaDate(raw: string | undefined, country: "USA" | "CAN" | null): string | null {
  if (!raw || !/^\d{8}$/.test(raw)) return null;
  const canadian = country === "CAN" || /^(19|20)\d{2}(0[1-9]|1[0-2])/.test(raw.slice(0, 6));
  const [y, m, d] = canadian
    ? [raw.slice(0, 4), raw.slice(4, 6), raw.slice(6, 8)]
    : [raw.slice(4, 8), raw.slice(0, 2), raw.slice(2, 4)];
  if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${m}-${d}`;
}

const title = (s: string) => s.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase());

/** The four fields from an AAMVA barcode's text, or null when it isn't one or a field is missing. */
export function readIdBarcode(text: string): IdScanFields | null {
  if (!text.includes("ANSI ") && !text.includes("AAMVA")) return null;
  const elements = new Map<string, string>();
  for (const line of text.split(LINE_BREAKS)) {
    // The header line ends with the subfile designator ("DL" or "ID") straight before the first element.
    const header = /^ANSI .*(?:DL|ID)(D[A-Z]{2}.*)$/.exec(line.trim());
    const trimmed = header ? header[1]! : line.trim();
    const m = ELEMENT.exec(trimmed);
    if (m && !elements.has(m[1]!)) elements.set(m[1]!, m[2]!.trim());
  }
  const country = (elements.get("DCG") as "USA" | "CAN" | undefined) ?? null;
  const first = elements.get("DAC") ?? elements.get("DCT")?.split(/[ ,]/)[0];
  const last = elements.get("DCS") ?? elements.get("DAB");
  const idNumber = elements.get("DAQ");
  const dateOfBirth = aamvaDate(elements.get("DBB"), country);
  const expiration = aamvaDate(elements.get("DBA"), country);
  if (!first || !last || !idNumber || !dateOfBirth || !expiration) return null;
  return { name: `${title(first)} ${title(last)}`, dateOfBirth, idNumber, expiration };
}

/** Keeps only the rule pack's fields: what the server stores, whatever else a client sent. */
export function onlyPackFields(
  input: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = input[f];
    if (typeof v === "string" && v.trim() !== "") out[f] = v.trim();
  }
  return out;
}
