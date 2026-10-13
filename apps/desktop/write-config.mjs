// Writes build-resources/west4.json for the packaged app (W-01): the staff app's and the API's
// addresses this build opens, from WEST4_STAFF_URL and WEST4_API_URL. Empty values leave the app on
// its environment or the local staff app (src/config.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { env, stdout } from "node:process";

mkdirSync("build-resources", { recursive: true });
const config = {
  staffUrl: env.WEST4_STAFF_URL || null,
  apiUrl: env.WEST4_API_URL || null,
};
writeFileSync("build-resources/west4.json", `${JSON.stringify(config, null, 2)}\n`);
stdout.write(
  `west4.json: staff ${config.staffUrl ?? "(not set)"}, api ${config.apiUrl ?? "(not set)"}\n`,
);
