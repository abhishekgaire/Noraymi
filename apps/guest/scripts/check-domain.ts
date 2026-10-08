import { promises as dns } from "node:dns";
import { readFileSync, writeFileSync } from "node:fs";
import tls from "node:tls";
import {
  certDaysLeft,
  mailChanges,
  urlProblems,
  type MailRecords,
  type UrlAnswer,
} from "../domain-check";
import { LEGACY_PAGES } from "../legacy-redirects";

/**
 * `pnpm --filter @west4/guest check:domain -- --host west4karaoke.com [--dkim <selector>]…
 *   [--save before.json] [--expect before.json] [--no-urls]` (M9-09; docs/runbooks/domain-move.md).
 * Prints the domain's DNS, its certificate and what every old URL answers. `--save` keeps the
 * email records before the move; `--expect` fails when any of them changed after it.
 */
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const all = (name: string) =>
  process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] ? [process.argv[i + 1]!] : []));

const txt = async (name: string) =>
  (await dns.resolveTxt(name).catch(() => [] as string[][])).map((parts) => parts.join(""));

async function mail(host: string, selectors: readonly string[]): Promise<MailRecords> {
  const mx = (await dns.resolveMx(host).catch(() => [])).map((r) => `${r.priority} ${r.exchange}`);
  const spf = (await txt(host)).filter((r) => r.toLowerCase().startsWith("v=spf1"));
  const dmarc = await txt(`_dmarc.${host}`);
  const dkim: Record<string, string[]> = {};
  for (const s of selectors) dkim[s] = await txt(`${s}._domainkey.${host}`);
  return { mx, spf, dmarc, dkim };
}

function cert(host: string): Promise<{ validTo: string; authorized: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const c = socket.getPeerCertificate();
      resolve({
        validTo: c.valid_to,
        authorized: socket.authorized,
        ...(socket.authorizationError ? { error: String(socket.authorizationError) } : {}),
      });
      socket.end();
    });
    socket.on("error", (e) => resolve({ validTo: "", authorized: false, error: e.message }));
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ validTo: "", authorized: false, error: "timed out" });
    });
  });
}

async function answer(origin: string, url: string): Promise<UrlAnswer> {
  const first = await fetch(origin + url, { redirect: "manual" }).catch(() => null);
  const final = await fetch(origin + url, { redirect: "follow" }).catch(() => null);
  return { url, first: first?.status ?? 599, final: final?.status ?? 599 };
}

async function main(): Promise<void> {
  const host = arg("--host");
  if (!host)
    throw new Error(
      "usage: check:domain -- --host <domain> [--dkim <selector>] [--save f] [--expect f]",
    );
  const problems: string[] = [];
  for (const name of [host, `www.${host}`]) {
    const a = await dns.resolve4(name).catch(() => []);
    const cname = await dns.resolveCname(name).catch(() => []);
    console.warn(`${name}: A ${a.join(", ") || "none"}; CNAME ${cname.join(", ") || "none"}`);
  }
  const records = await mail(host, all("--dkim"));
  console.warn(
    `mail: MX ${records.mx.join(", ") || "none"}; SPF ${records.spf.length}; DMARC ${records.dmarc.length}; DKIM ${Object.keys(records.dkim).length}`,
  );
  const save = arg("--save");
  if (save) writeFileSync(save, JSON.stringify(records, null, 2));
  const expectFile = arg("--expect");
  if (expectFile)
    problems.push(
      ...mailChanges(JSON.parse(readFileSync(expectFile, "utf8")) as MailRecords, records),
    );
  const c = await cert(host);
  const days = c.validTo ? certDaysLeft(c.validTo, new Date()) : -1;
  console.warn(
    `certificate: ${c.authorized ? "valid" : `not valid (${c.error ?? "unknown"})`}, ${days} days left`,
  );
  if (!c.authorized)
    problems.push(`the certificate for ${host} isn't valid: ${c.error ?? "unknown"}`);
  else if (days < 14) problems.push(`the certificate for ${host} expires in ${days} days`);
  if (!process.argv.includes("--no-urls")) {
    const answers = [];
    for (const url of LEGACY_PAGES) answers.push(await answer(`https://${host}`, url));
    for (const a of answers)
      console.warn(`${a.url} → ${a.first}${a.first !== a.final ? ` → ${a.final}` : ""}`);
    problems.push(...urlProblems(answers));
  }
  if (problems.length) {
    console.error(`the domain check failed for ${host}:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.warn(`the domain check passed for ${host}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
