import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("character settings preserve literal lore keys and save an explicit draft", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/e2e/fixtures/roleplay-settings.html");
  await expect(page.getByRole("textbox", { name: "Character name", exact: true })).toHaveValue(
    "Mira",
  );
  await page
    .getByRole("textbox", { name: "Personality", exact: true })
    .fill("Careful, curious, and quietly determined.");
  await captureScreenshot(page, testInfo, "roleplay-settings-desktop");
  await page
    .locator("summary")
    .filter({ hasText: /^Lorebook$/ })
    .click();
  await page
    .locator("summary")
    .filter({ hasText: /^Glass Harbor/ })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Primary keys 2", exact: true }).first(),
  ).toHaveValue("harbor, east");
  await page.getByRole("textbox", { name: "Scan depth", exact: true }).fill("");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText("Enter a whole number from 0 to 100.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Scan depth", exact: true }).fill("5");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Changes saved");
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("textbox", { name: "Character name", exact: true }).fill("Mira Vale");
  await captureScreenshot(page, testInfo, "roleplay-settings-mobile");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
