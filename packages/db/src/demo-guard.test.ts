import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { demoApiAnswering, demoWipeRefusal, WIPE_DEMO_FLAG } from "./demo-guard.js";

const demoUrl = "postgres://west4:west4@localhost:5432/west4";
const up = () => Promise.resolve(true);
const down = () => Promise.resolve(false);

describe("db:reset and seed refuse to wipe the running demo", () => {
  it("refuses the demo database while the demo API answers", async () => {
    for (const command of ["reset", "seed"] as const) {
      const refusal = await demoWipeRefusal({ command, url: demoUrl, argv: [], apiAnswering: up });
      expect(refusal).toContain("demo API on :3000");
      expect(refusal).toContain(WIPE_DEMO_FLAG);
    }
  });

  it("goes ahead with the flag, with the demo stopped, or on another database", async () => {
    const flagged = { command: "reset" as const, url: demoUrl, argv: [WIPE_DEMO_FLAG] };
    expect(await demoWipeRefusal({ ...flagged, apiAnswering: up })).toBeNull();
    expect(
      await demoWipeRefusal({ command: "reset", url: demoUrl, argv: [], apiAnswering: down }),
    ).toBeNull();
    const other = "postgres://west4:west4@localhost:5432/west4_e2e";
    expect(
      await demoWipeRefusal({ command: "seed", url: other, argv: [], apiAnswering: up }),
    ).toBeNull();
  });

  it("asks the health route itself", async () => {
    const server = createServer((_request, response) => response.end("{}"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    expect(await demoApiAnswering(`http://127.0.0.1:${port}/v1/health`)).toBe(true);
    await new Promise((resolve) => server.close(resolve));
    expect(await demoApiAnswering(`http://127.0.0.1:${port}/v1/health`)).toBe(false);
  });
});
