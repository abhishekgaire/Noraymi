import { expect, test } from "@playwright/test";

test("the Console opens", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Console");
});
