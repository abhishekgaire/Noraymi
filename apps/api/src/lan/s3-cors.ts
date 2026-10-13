import { PutBucketCorsCommand } from "@aws-sdk/client-s3";
import { makeS3 } from "../s3.js";
import { lanCorsRules, parseLanPorts } from "./lan.js";

/**
 * `tsx src/lan/s3-cors.ts` (scripts/demo-start.sh --lan): the local photo bucket lets the apps on
 * the Wi-Fi address upload, as well as the laptop's own. Local only.
 */
if ((process.env["WEST4_ENV"] ?? "local") !== "local") throw new Error("lan s3-cors is local only");
const env = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
);
const s3 = makeS3(process.env);
await s3.client.send(
  new PutBucketCorsCommand({
    Bucket: s3.bucketFiles,
    CORSConfiguration: { CORSRules: lanCorsRules(env, parseLanPorts(env["LAN_PORTS"])) },
  }),
);
console.warn(`Photo uploads allowed from ${env["STAFF_APP_URL"]} and ${env["GUEST_APP_URL"]}.`);
