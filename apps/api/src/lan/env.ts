import { networkInterfaces } from "node:os";
import { checkLanIp, lanEnv, parseLanPorts, pickLanIp, shellExports } from "./lan.js";

/**
 * `tsx src/lan/env.ts [--lan-ip <ip>]`: the `export` lines scripts/demo-start.sh --lan evals, so
 * every link the apps make carries the laptop's Wi-Fi address. Exits 1, saying why, when the
 * laptop has no Wi-Fi address.
 */
const args = process.argv.slice(2);
const at = args.indexOf("--lan-ip");
const given = at >= 0 ? args[at + 1] : undefined;
try {
  const ip = given ? checkLanIp(given) : pickLanIp(networkInterfaces());
  if (!ip) {
    console.error(
      "This laptop has no Wi-Fi address. Join the shop's Wi-Fi first, or pass --lan-ip <address>.",
    );
    process.exit(1);
  }
  process.stdout.write(
    `${shellExports(lanEnv({ ip, ports: parseLanPorts(process.env["LAN_PORTS"]) }))}\n`,
  );
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
