import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
for (const width of [1440, 390]) {
  test(`agent activity follows tool outcomes at width ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/e2e/fixtures/agent-activity.html");
    const panel = page.getByTestId("agent-activity");
    await panel.getByRole("button", { name: "Agent activity" }).click();
    await expect(panel.getByText("Reasoning summary")).toBeVisible();
    await expect(panel.getByText("Read file")).toBeVisible();
    await expect(panel.locator('[data-status="running"]')).toHaveCount(1);
    await page.getByRole("button", { name: "Finish fixture call" }).click();
    await expect(panel.getByText("Fixture file was not found")).toBeVisible();
    await expect(panel.locator('[data-status="error"]')).toHaveCount(1);
    await expect(panel.locator('[data-status="running"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await captureScreenshot(page, testInfo, `agent-activity-${width}`);
  });
}
