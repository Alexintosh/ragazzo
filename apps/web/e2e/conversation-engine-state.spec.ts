import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("Eros settings show the character and expose explicit conversation debug edits", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto("/e2e/fixtures/conversation-engine-state.html");
  await expect(
    page.getByText("A careful cartographer. Stay in character.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Curious about the unfamiliar chart.", { exact: true }),
  ).not.toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: /^Eros debug$/ })
    .click();
  await expect(
    page.getByText("Curious about the unfamiliar chart.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Medium", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Trust", exact: true }).fill("0.8");
  await captureScreenshot(page, testInfo, "eros-character-debug-desktop");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Trust", exact: true })).toHaveValue("0.2");
  await page.getByRole("textbox", { name: "Trust", exact: true }).fill("0.7");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Trust", exact: true })).toHaveValue("0.7");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "eros-character-debug-mobile");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
