import { expect, test } from "@playwright/test";
import { DEFAULT_BOT_AVATAR_COLOR } from "@rakazo/core";
import { captureScreenshot } from "./helpers";

test("a bot's model and effort can change directly from its chat header", async ({
  page,
}, testInfo) => {
  const botId = "11111111-1111-4111-8111-111111111111";
  const saved: unknown[] = [];
  const models = {
    runtimeKind: "codex",
    available: true,
    defaultModelId: "gpt-5.4",
    models: [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        thinkingLevels: ["low", "medium", "high", "xhigh"],
        defaultThinkingLevel: "medium",
        isDefault: true,
      },
      {
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        thinkingLevels: ["low", "medium", "high"],
        defaultThinkingLevel: "medium",
        isDefault: false,
      },
    ],
  };
  await page.route("**/rpc/bots/runtimeModels", (route) =>
    route.fulfill({ json: { json: models } }),
  );
  await page.route("**/rpc/bots/setRuntimeModel", async (route) => {
    const { json: input } = route.request().postDataJSON() as {
      json: { botId: string; modelId: string; thinkingLevel: string | null };
    };
    saved.push(input);
    expect(route.request().headers()["x-rakazo-space-id"]).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    await route.fulfill({
      json: {
        json: {
          ...input,
          id: botId,
          spaceId: "22222222-2222-4222-8222-222222222222",
          name: "Scout",
          runtimeKind: "codex",
          registeredHostId: null,
          modelProvider: "codex-native",
          updatedAt: "2026-01-02T00:00:00.000Z",
          color: DEFAULT_BOT_AVATAR_COLOR,
          status: "idle",
        },
      },
    });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/e2e/fixtures/bot-model-picker.html");
  const trigger = page.getByRole("button", { name: "Model and effort", exact: true });
  await expect(trigger).toContainText("GPT-5.4");
  await trigger.click();
  await expect(page.getByRole("option", { name: "GPT-5.4", exact: true })).toHaveAttribute(
    "data-checked",
    "true",
  );
  await expect(page.getByRole("combobox", { name: "Reasoning effort" })).toHaveValue("medium");
  await captureScreenshot(page, testInfo, "bot-model-picker-desktop");
  await page.getByRole("combobox", { name: "Search models" }).fill("5.3");
  await expect(page.getByRole("option", { name: "GPT-5.4", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "GPT-5.3 Codex", exact: true }).click();
  await expect(trigger).toContainText("GPT-5.3 Codex");
  await page.getByRole("combobox", { name: "Reasoning effort" }).selectOption("high");
  await expect(trigger).toContainText("High");
  expect(saved).toEqual([
    { botId, modelId: "gpt-5.3-codex", thinkingLevel: "medium" },
    { botId, modelId: "gpt-5.3-codex", thinkingLevel: "high" },
  ]);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await expect(page.getByRole("combobox", { name: "Search models" })).toBeVisible();
  const bounds = await page.locator('[data-slot="popover-content"]').boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "bot-model-picker-mobile");
});
