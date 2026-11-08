import { expect, test } from "@playwright/test";
import type { ThreadQueue, ThreadSnapshot } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";

test("group queue requires a recipient and preserves each recipient's waiting work", async ({
  page,
}, testInfo) => {
  await signup(page, `group-queue-${Date.now()}@rakazo.test`, "password12", "Group Queue");
  await completeOnboarding(page);
  const first = activeBotId(page);
  const second = await createNamedBot(page, "Queue colleague");
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Group work",
    botIds: [first, second],
  });
  await rpc(page, "threads/send", {
    groupId: group.id,
    text: "ask me which city to use",
    mentions: [first],
  });
  await expect
    .poll(async () =>
      (await rpc<ThreadSnapshot>(page, "threads/get", { groupId: group.id })).activeRuns?.some(
        (run) => run.status === "waiting_input",
      ),
    )
    .toBe(true);
  await page.goto(`/app/g/${group.id}`);
  await expect(page.getByRole("combobox", { name: "Queue recipient" })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Queue recipient" }).selectOption(first);
  await page.getByRole("combobox", { name: "Message Group work" }).fill("Waiting for first member");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect
    .poll(async () =>
      (
        await rpc<ThreadQueue>(page, "threads/queue", { groupId: group.id, recipientBotId: first })
      ).entries.map((entry) => entry.text),
    )
    .toEqual(["Waiting for first member"]);
  await page.getByRole("combobox", { name: "Queue recipient" }).selectOption(second);
  await expect(page.getByTestId("thread-queue")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Queue recipient" }).selectOption(first);
  await page.getByTestId("thread-queue").locator("summary").click();
  await expect(page.getByTestId("thread-queue")).toContainText("Waiting for first member");
  await captureScreenshot(page, testInfo, "group-recipient-queue");
  await rpc(page, "threads/stop", { groupId: group.id });
});

test("first-task suggestion becomes a draft and retains selected runtime", async ({
  page,
}, testInfo) => {
  await signup(page, `first-task-${Date.now()}@rakazo.test`, "password12", "First Task");
  await completeOnboarding(page);
  const botId = await createNamedBot(page, "First task guide");
  await page.getByRole("button", { name: "Plan a project", exact: true }).click();
  const composer = page.getByRole("combobox", { name: "Message First task guide" });
  await expect(composer).toHaveValue(
    "Help me plan a project. Ask what I want to achieve and turn it into concrete next steps.",
  );
  const before = await rpc<ThreadSnapshot>(page, "threads/get", { botId });
  expect(before.messages.filter((message) => message.role === "user")).toHaveLength(0);
  await page.reload();
  await expect(composer).toHaveValue(
    "Help me plan a project. Ask what I want to achieve and turn it into concrete next steps.",
  );
  await captureScreenshot(page, testInfo, "first-task-draft");
});
