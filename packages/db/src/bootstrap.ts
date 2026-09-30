import pg from "pg";
import { builtInRulePacks } from "@west4/shared";
import { generateSigningKey, publishRulePack } from "./rule-packs.js";

/**
 * The bootstrap that loads the built-in rule packs (M1-10): 2026.09 signed
 * with the environment's key and recorded with two named approvers. Later
 * versions go through the Console (M1-36). Runs after every migrate; a
 * version that exists is left alone.
 *
 * RULE_PACK_SIGNING_KEY is the Ed25519 private key (PEM). Locally, when it's
 * unset, a throwaway key is generated for the load, so development needs no
 * key; the Console's publishing does.
 */
export async function loadBuiltInRulePacks(
  databaseUrl: string,
  log: (line: string) => void,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  let privateKeyPem = env["RULE_PACK_SIGNING_KEY"];
  if (privateKeyPem === undefined || privateKeyPem === "") {
    if ((env["WEST4_ENV"] ?? "local") !== "local") {
      log("RULE_PACK_SIGNING_KEY is not set: built-in rule packs not loaded");
      return;
    }
    privateKeyPem = generateSigningKey().privateKeyPem;
  }
  const approvers = (env["RULE_PACK_APPROVERS"] ?? "Abhishek Gaire,Claude Code").split(",");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const pack of builtInRulePacks) {
      const effectiveOn = env["RULE_PACK_EFFECTIVE_ON"] ?? "2026-09-01";
      const result = await publishRulePack(client, {
        pack,
        effectiveOn,
        approvedBy: approvers,
        privateKeyPem,
      });
      log(
        `rule pack ${pack.id} ${pack.version}: ${result.inserted ? "loaded" : "already loaded"} (key ${result.keyId})`,
      );
    }
  } finally {
    await client.end();
  }
}
