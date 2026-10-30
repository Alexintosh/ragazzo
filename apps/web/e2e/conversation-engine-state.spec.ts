import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("Eros settings show the character and expose explicit conversation debug edits", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto("/e2e/fixtures/conversation-engine-state.html");
  await expect(
    page.getByText("A careful cartographer. Stay in character.", {
      exact: true,
    }),
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
  await expect(
    page
      .getByText("Emotional need", { exact: true })
      .locator("..")
      .getByText("Medium", { exact: true }),
  ).toBeVisible();
  await page.getByRole("spinbutton", { name: "Trust", exact: true }).fill("0.8");
  await page
    .locator("summary")
    .filter({ hasText: /^Time$/ })
    .click();
  await expect(page.getByText("Engine time", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Simulates relationship time and clears the feeling summary. The engine clock and message dates stay unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByRole("spinbutton", {
      name: "Simulate elapsed hours (0–720)",
      exact: true,
    })
    .fill("48");
  await captureScreenshot(page, testInfo, "eros-character-debug-desktop");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Trust", exact: true })).toHaveValue("0.2");
  await page.getByRole("spinbutton", { name: "Trust", exact: true }).fill("0.7");
  await page
    .getByRole("spinbutton", {
      name: "Simulate elapsed hours (0–720)",
      exact: true,
    })
    .fill("48");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText("Affinity elapsed hours", { exact: true }).locator(".."),
  ).toContainText("48");
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Trust", exact: true })).toHaveValue("0.7");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "eros-character-debug-mobile");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("Eros exposes eight areas and saves native request controls", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto("/e2e/fixtures/conversation-engine-state.html");
  for (const label of [
    "Needs",
    "Relationship evolution",
    "User insights",
    "Events and daily life",
    "Inventory and outfit",
    "Initiative and greetings",
    "Behavior traits",
    "Model generation",
  ]) {
    await expect(
      page.locator("summary").filter({ hasText: new RegExp(`^${label}$`) }),
    ).toBeVisible();
  }
  await page
    .locator("summary")
    .filter({ hasText: /^Needs$/ })
    .click();
  await expect(page.getByText("Direct overrides are unavailable.", { exact: false })).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: /^Model generation$/ })
    .click();
  await page.getByRole("combobox", { name: "Model tier", exact: true }).selectOption("fast");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Model tier", exact: true })).toHaveValue("fast");
  await page
    .locator("summary")
    .filter({ hasText: /^Inventory and outfit$/ })
    .click();
  await page.getByRole("textbox", { name: "Item name", exact: true }).fill("Compass");
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove Compass", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "eros-eight-controls-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "eros-eight-controls-mobile");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
