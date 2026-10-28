import { expect, test } from "@playwright/test";
import type { Routine } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("routine calendar navigates day, week and month and opens a routine", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `routine-calendar-${Date.now()}@rakazo.test`,
    "password12",
    "Routine Calendar",
  );
  await completeOnboarding(page);
  await rpc<Routine>(page, "routines/create", {
    botId: activeBotId(page),
    name: "Daily review",
    prompt: "Review today's work",
    crons: ["0 * * * *"],
    timezone: "UTC",
    active: true,
    notify: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  const calendar = page.getByTestId("routine-calendar");
  await expect(calendar).toBeVisible();
  await calendar.getByRole("combobox", { name: "Calendar view" }).selectOption("day");
  await calendar.getByRole("button", { name: "Next period" }).click();
  await expect(calendar.getByTestId("routine-calendar-entry").first()).toContainText("Scheduled");
  await calendar.getByRole("button", { name: "Previous period" }).click();
  await calendar.getByRole("combobox", { name: "Calendar view" }).selectOption("month");
  await captureScreenshot(page, testInfo, "routine-calendar-month");
  await calendar.getByRole("combobox", { name: "Calendar view" }).selectOption("week");
  await calendar.getByRole("button", { name: "Next period" }).click();
  await captureScreenshot(page, testInfo, "routine-calendar-week");
  await calendar.getByRole("button", { name: "Daily review", exact: true }).first().click();
  await expect(page.locator("label:has-text('Name') input")).toHaveValue("Daily review");
});
