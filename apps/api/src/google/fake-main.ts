import { FakeGoogle } from "./fake.js";
import { FAKE_GOOGLE_PORT } from "./settings.js";

/**
 * `pnpm --filter @west4/api google:fake`: the fake Google on port 12112, with
 * one test location. Local runs only; it never touches a real profile.
 */
const fake = new FakeGoogle();
const port = Number(process.env["GOOGLE_FAKE_PORT"] ?? FAKE_GOOGLE_PORT);
const base = await fake.start(port, "127.0.0.1");
console.warn(`fake Google on ${base}`);
const stop = () => void fake.stop().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
