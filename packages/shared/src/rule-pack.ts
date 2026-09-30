/**
 * Rule packs (spec 03 · Rule packs; spec 12 · 11): versioned legal data for
 * one place. Money math and settings screens read limits only from here,
 * never from code. A version is signed, needs two approvers on our side and
 * takes effect at a business-date boundary.
 */
export interface RulePack {
  readonly id: string;
  readonly version: string;
  readonly timeZone: string;
  readonly alcohol: {
    /** Wall-clock times, resolved for each business date. */
    readonly lastSale: string;
    readonly drinkingUpMin: number;
    readonly promotions: {
      readonly freeDrinks: boolean;
      readonly multipleForOne: "eachAtLeastHalfPrice";
      readonly hourlyAlcohol: boolean;
    };
  };
  readonly salesTax: {
    readonly rate: number;
    /** The jurisdiction code from the accountant; null until answered (Open technical questions). */
    readonly jurisdictionCode: string | null;
    readonly surchargeTaxable: boolean;
  };
  readonly wages: {
    readonly region: string;
    readonly minimumCents: number;
    readonly tippedCashCents: number;
    readonly tipCreditCents: number;
  };
  readonly cardFee: {
    readonly surcharge: {
      readonly creditOnly: boolean;
      readonly cap: "inPersonCardCost";
      readonly networkCapPct: number;
      readonly noticeDays: number;
      readonly showCreditPrice: boolean;
    };
    readonly discount: { readonly allowed: boolean };
  };
  readonly gratuity: {
    readonly label: string;
    readonly staffOnly: boolean;
    readonly managersShare: boolean;
    readonly eligibility: "dutiesWorked";
  };
  readonly cash: { readonly mustAccept: boolean };
  readonly idScan: { readonly fields: readonly string[]; readonly keepDays: number };
  readonly texting: {
    readonly marketingFrom: string;
    readonly marketingTo: string;
    readonly clock: "recipient";
  };
  readonly retention: {
    readonly tipRecordsYears: number;
    readonly guestChecksYears: number;
    readonly incidentsYears: number;
  };
}

/** The New York County pack, exactly as spec 03 gives it. */
export const newYorkCounty: RulePack = {
  id: "us-ny-new-york-county",
  version: "2026.09",
  timeZone: "America/New_York",
  alcohol: {
    lastSale: "04:00",
    drinkingUpMin: 30,
    promotions: { freeDrinks: false, multipleForOne: "eachAtLeastHalfPrice", hourlyAlcohol: false },
  },
  // The code and the surcharge rule come from the accountant (Open technical questions).
  salesTax: { rate: 0.08875, jurisdictionCode: null, surchargeTaxable: true },
  wages: { region: "nyc", minimumCents: 1700, tippedCashCents: 1135, tipCreditCents: 565 },
  cardFee: {
    surcharge: {
      creditOnly: true,
      cap: "inPersonCardCost",
      networkCapPct: 3,
      noticeDays: 30,
      showCreditPrice: true,
    },
    discount: { allowed: true },
  },
  gratuity: {
    label: "Gratuity",
    staffOnly: true,
    managersShare: false,
    eligibility: "dutiesWorked",
  },
  cash: { mustAccept: true },
  idScan: { fields: ["name", "dateOfBirth", "idNumber", "expiration"], keepDays: 7 }, // until the lawyer answers
  texting: { marketingFrom: "08:00", marketingTo: "21:00", clock: "recipient" },
  retention: { tipRecordsYears: 6, guestChecksYears: 3, incidentsYears: 3 },
};

export const builtInRulePacks: readonly RulePack[] = [newYorkCounty];

/**
 * Canonical JSON: keys sorted at every level, no whitespace, so the same pack
 * always signs to the same bytes whatever produced it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export interface RulePackChange {
  readonly path: string;
  readonly from: unknown;
  readonly to: unknown;
}

/** What changes between two versions: the data behind Admin's notice (M1-36). */
export function rulePackChanges(current: RulePack, next: RulePack): RulePackChange[] {
  const changes: RulePackChange[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of [...keys].sort())
        walk(a[key], b[key], path === "" ? key : `${path}.${key}`);
      return;
    }
    if (canonicalJson(a) !== canonicalJson(b)) changes.push({ path, from: a, to: b });
  };
  walk(current, next, "");
  return changes.filter((c) => c.path !== "version");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
