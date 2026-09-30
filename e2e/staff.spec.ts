import { expect, test } from "@playwright/test";

test("the staff app opens", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff app");
});
