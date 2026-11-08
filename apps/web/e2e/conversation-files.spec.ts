import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("conversation files reuse artifacts and return to the source attachment", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `conversation-files-${Date.now()}@rakazo.test`,
    "password12",
    "Conversation Files",
  );
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = activeBotId(page);
  const attachment = await rpc<{ id: string }>(page, "artifacts/create", {
    botId,
    name: "source.txt",
    mimeType: "text/plain",
    contentBase64: Buffer.from("Conversation source").toString("base64"),
  });
  await rpc(page, "threads/send", { botId, text: "Keep this file", artifactIds: [attachment.id] });
  await page.reload();
  await page.getByRole("button", { name: "Conversation files", exact: true }).click();
  const panel = page.getByTestId("conversation-files-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("link", { name: "source.txt", exact: true })).toBeVisible();
  await expect(panel).toContainText("Attachment");
  await expect(panel.getByTestId("conversation-files-storage")).toContainText("19 B");
  await captureScreenshot(page, testInfo, "conversation-files");
  const downloadReady = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download source.txt", exact: true }).click();
  expect((await downloadReady).suggestedFilename()).toBe("source.txt");
  await panel.getByRole("button", { name: "Show message for source.txt", exact: true }).click();
  await expect(panel).not.toBeVisible();
  await expect(
    page.getByTestId("transcript").getByText("Keep this file", { exact: true }),
  ).toBeInViewport();
});
