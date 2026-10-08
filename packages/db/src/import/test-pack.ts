import type pg from "pg";
import { newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { generateSigningKey, publishRulePack } from "../rule-packs.js";

/** For the import's tests: New York County's rule packs, signed with a throwaway key. */
export async function publishTestRulePack(owner: pg.Client | pg.Pool): Promise<void> {
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
}
