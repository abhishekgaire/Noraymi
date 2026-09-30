// The post-deploy smoke test (M1-02): the API's health route answers with
// server_time, and the staff app, the Console and the guest web each load
// from their own hostname. Usage: node scripts/smoke-staging.mjs <api> <staff> <console> <guest>
const [api, staff, consoleUrl, guest] = process.argv.slice(2);
if (!api || !staff || !consoleUrl || !guest) {
  console.error("usage: smoke-staging.mjs <api url> <staff url> <console url> <guest url>");
  process.exit(2);
}

async function retry(label, fn, tries = 10) {
  for (let i = 1; i <= tries; i += 1) {
    try {
      return await fn();
    } catch (error) {
      if (i === tries)
        throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }
  }
}

const health = await retry("health", async () => {
  const res = await fetch(new URL("/v1/health", api));
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = await res.json();
  if (body.ok !== true || typeof body.server_time !== "string")
    throw new Error(`bad body ${JSON.stringify(body)}`);
  return body;
});
console.log(`api ok · server_time ${health.server_time}`);

for (const [name, url, expected] of [
  ["staff", staff, "Staff app"],
  ["console", consoleUrl, "Console"],
  ["guest", guest, "Guest web"],
]) {
  await retry(name, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const text = await res.text();
    if (!text.includes(expected)) throw new Error(`page doesn't mention "${expected}"`);
  });
  console.log(`${name} ok · ${new URL(url).host}`);
}
