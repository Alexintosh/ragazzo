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

test("chat settings disclose spontaneous messages and conversation relationship debug", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/e2e/fixtures/roleplay-settings.html");
  await expect(page.getByRole("switch", { name: "Spontaneous messages", exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("Conversation style", { exact: true }).selectOption("chat");
  await expect(
    page.getByRole("switch", { name: "Spontaneous messages", exact: true }),
  ).not.toBeChecked();
  await page.getByRole("switch", { name: "Spontaneous messages", exact: true }).click();
  await expect(page.getByLabel("Frequency", { exact: true })).toHaveValue("balanced");
  await expect(
    page.getByRole("switch", { name: "Late-night messages", exact: true }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: /^Relationship debug$/ })
    .click();
  await expect(page.getByRole("textbox", { name: "Warmth", exact: true })).toHaveValue("35");
  await page.getByRole("textbox", { name: "Warmth", exact: true }).fill("70");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Warmth", exact: true })).toHaveValue("35");
  await captureScreenshot(page, testInfo, "roleplay-chat-spontaneous-relationship-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "roleplay-chat-spontaneous-relationship-mobile");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("image album imports, edits metadata, and saves a character draft", async ({
  page,
}, testInfo) => {
  const pixel =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=";
  await page.route("**/rpc/bots/importRoleplayMedia", (route) =>
    route.fulfill({
      json: { json: { id: "fixture-image", name: "Harbor at dusk", mimeType: "image/png" } },
    }),
  );
  await page.route("**/rpc/artifacts/get", (route) =>
    route.fulfill({
      json: { json: { id: "fixture-image", mimeType: "image/png", contentBase64: pixel } },
    }),
  );
  await page.goto("/e2e/fixtures/roleplay-settings.html");
  await page
    .locator("summary")
    .filter({ hasText: /^Images$/ })
    .click();
  await page
    .locator("summary")
    .filter({ hasText: /^Import from URL$/ })
    .click();
  await page.getByLabel("Image URL", { exact: true }).fill("https://example.com/harbor.png");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: /^Harbor at dusk$/ })
    .click();
  await page.locator('textarea[maxlength="800"]').fill("Mira watching the harbor at dusk");
  await page.getByLabel("Scene", { exact: true }).fill("Glass Harbor");
  await page
    .locator("summary")
    .filter({ hasText: /^Frequency$/ })
    .click();
  await page.getByLabel("Normal chat: turns between images", { exact: true }).fill("8");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Changes saved");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await captureScreenshot(page, testInfo, "roleplay-images-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "roleplay-images-mobile");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
