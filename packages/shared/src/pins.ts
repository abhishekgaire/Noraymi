/**
 * PIN rules (spec 02 · PINs, M1-23). Staff PINs have 4 digits, managers' and
 * owners' 6. Common and sequential PINs are refused, so a guessed PIN takes
 * more than a handful of tries. The list is the usual top guesses plus every
 * run of one digit and every straight run up or down.
 */
export const PIN_BLOCKLIST: readonly string[] = [
  // 4 digits: the most-used PINs in published breach counts.
  "1234",
  "1111",
  "0000",
  "1212",
  "7777",
  "1004",
  "2000",
  "4444",
  "2222",
  "6969",
  "9999",
  "3333",
  "5555",
  "6666",
  "1122",
  "1313",
  "8888",
  "4321",
  "2001",
  "1010",
  "2580",
  "0852",
  "1998",
  "1999",
  "2020",
  "2021",
  "2022",
  "2023",
  "2024",
  "2025",
  "2026",
  "1990",
  "1991",
  "1992",
  "1993",
  "1994",
  "1995",
  "1996",
  "1997",
  "2468",
  "1357",
  "0007",
  "1221",
  "1123",
  "6789",
  "4567",
  "1230",
  "0123",
  // 6 digits.
  "123456",
  "111111",
  "000000",
  "123123",
  "654321",
  "112233",
  "121212",
  "666666",
  "696969",
  "123321",
  "100000",
  "159753",
  "222222",
  "777777",
  "999999",
  "888888",
  "123654",
  "456789",
  "234567",
  "345678",
  "567890",
  "098765",
  "987654",
  "876543",
  "765432",
  "543210",
  "147258",
  "258147",
  "369258",
  "159357",
  "131313",
  "101010",
  "202020",
  "010101",
  "111222",
  "121314",
];

export type PinProblem = "length" | "digits" | "repeated" | "sequential" | "common";

const isRun = (pin: string, step: 1 | -1): boolean =>
  [...pin].every((d, i) => i === 0 || Number(d) === (Number(pin[i - 1]!) + step + 10) % 10);

/** Why a PIN is refused, or null when it may be used. */
export function pinProblem(pin: string, digits: 4 | 6): PinProblem | null {
  if (!/^\d+$/.test(pin)) return "digits";
  if (pin.length !== digits) return "length";
  if (new Set(pin).size === 1) return "repeated";
  if (isRun(pin, 1) || isRun(pin, -1)) return "sequential";
  if (PIN_BLOCKLIST.includes(pin)) return "common";
  return null;
}
