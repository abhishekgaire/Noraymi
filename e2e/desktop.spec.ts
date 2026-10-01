import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "..", "apps", "desktop");

test("the desktop app opens the staff app", async () => {
  const app = await electron.launch({
    args: [desktopDir],
    env: { ...process.env, STAFF_URL: "http://localhost:5173" },
  });
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  } finally {
    await app.close();
  }
});
