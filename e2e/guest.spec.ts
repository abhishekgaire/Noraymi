import { expect, test } from "@playwright/test";

test("the guest web opens", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Guest web");
});
