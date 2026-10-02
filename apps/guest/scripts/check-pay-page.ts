import { checkPayPage } from "../pay-check";

/**
 * `pnpm --filter @west4/guest check:pay -- <page url> [--dev]` (M4-15): loads the live payment page and
 * checks its scripts and headers against the policy. Runs after every deploy and weekly
 * (.github/workflows/pay-page-check.yml); a non-zero exit fails the deploy or raises the alert.
 */
async function main(): Promise<void> {
  const url = process.argv.find((a) => /^https?:\/\//.test(a));
  if (!url) throw new Error("usage: check:pay -- <payment page url> [--dev]");
  const r = await fetch(url, { redirect: "manual" });
  const html = await r.text();
  const headers = Object.fromEntries([...r.headers.entries()]);
  const problems = checkPayPage({
    html,
    headers,
    requireIntegrity: !process.argv.includes("--dev"),
  });
  if (problems.length) {
    console.error(`the payment page changed (${url}):\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.warn(`the payment page matches its policy (${url})`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
