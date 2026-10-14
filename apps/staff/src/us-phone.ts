/** A US mobile typed any way ("(917) 555-0144", "917-555-0144", "+1 917 555 0144") as E.164, or null. */
export const usE164 = (typed: string): string | null => {
  const digits = typed.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{9}$/.test(ten) ? `+1${ten}` : null;
};
