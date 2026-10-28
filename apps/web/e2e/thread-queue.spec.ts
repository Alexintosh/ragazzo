import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { ThreadQueue, ThreadSnapshot } from "@rakazo/contracts";
import {
  activeBotId,
  captureScreenshot,
  clickAndWaitForRpc,
  completeOnboarding,
  createNamedBot,
  rpc,
  signup,
} from "./helpers";

const composer = (page: Page) => page.getByRole("combobox", { name: /^Message/ });
const queuePanel = (page: Page) => page.getByTestId("thread-queue");
const readQueue = (page: Page, botId: string) => rpc<ThreadQueue>(page, "threads/queue", { botId });
const queueTexts = async (page: Page, botId: string) =>
  (await readQueue(page, botId)).entries.map((entry) => entry.text);

async function waitingConversation(page: Page, name: string) {
  await signup(page, `queue-${name}-${Date.now()}@rakazo.test`, "password12", "Queue Example");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await composer(page).fill("ask me which city to use");
  await composer(page).press("Enter");
  await expect(page.locator("p").filter({ hasText: /^Which city should I use\?$/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(async () => (await rpc<ThreadSnapshot>(page, "threads/get", { botId })).run?.status)
    .toBe("waiting_input");
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();
  return botId;
}

async function enqueue(page: Page, text: string) {
  await composer(page).fill(text);
  await clickAndWaitForRpc(
    page,
    page.getByRole("button", { name: "Queue", exact: true }),
    "threads/enqueue",
  );
  await expect(composer(page)).toHaveValue("");
}

async function expandQueue(page: Page) {
  const panel = queuePanel(page);
  await expect(panel).toBeVisible();
  if (!(await panel.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await panel.locator("summary").click();
  }
  return panel;
}

const rowFor = (panel: Locator, text: string) =>
  panel.getByRole("listitem").filter({ hasText: text });

test("queued work can be edited, ordered, cancelled and recovered after reload before approval finishes", async ({
  page,
}, testInfo) => {
  const botId = await waitingConversation(page, "durable");
  const first = "Prepare the sample release checklist";
  const revised = "Prepare the revised sample release checklist";
  const cancelled = "Prepare the discarded sample announcement";
  try {
    await enqueue(page, first);
    await enqueue(page, cancelled);
    await expect.poll(() => queueTexts(page, botId)).toEqual([first, cancelled]);
    let panel = await expandQueue(page);
    await expect(panel.getByText("Waiting for approval", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Steer", exact: true })).toHaveCount(0);
    await rowFor(panel, first).getByRole("button", { name: "Edit", exact: true }).click();
    await panel.getByRole("textbox", { name: "Edit queued message" }).fill(revised);
    await clickAndWaitForRpc(
      page,
      panel.getByRole("button", { name: "Save", exact: true }),
      "threads/updateQueued",
    );
    await rowFor(panel, revised).getByRole("button", { name: "Move down", exact: true }).click();
    await expect.poll(() => queueTexts(page, botId)).toEqual([cancelled, revised]);
    await expect(panel.getByRole("listitem").first()).toContainText(cancelled);
    await captureScreenshot(page, testInfo, "queue-edited-and-reordered");
    await clickAndWaitForRpc(
      page,
      rowFor(panel, cancelled).getByRole("button", { name: "Cancel", exact: true }),
      "threads/cancelQueued",
    );
    await expect.poll(() => queueTexts(page, botId)).toEqual([revised]);
    // Cancelling queued work must leave the original human interaction active.
    await expect
      .poll(async () => (await rpc<ThreadSnapshot>(page, "threads/get", { botId })).run?.status)
      .toBe("waiting_input");
    await page.reload({ waitUntil: "domcontentloaded" });
    panel = await expandQueue(page);
    await expect(panel.getByRole("listitem")).toHaveCount(1);
    await expect(panel.getByRole("listitem")).toContainText(revised);
    await expect(panel.getByText("Waiting for approval", { exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, "queue-persisted-awaiting-approval");
    await page.getByRole("button", { name: "Edit first", exact: true }).click();
    await page.getByRole("textbox", { name: "Answer", exact: true }).fill("Paris");
    await page.getByRole("button", { name: "Send answer", exact: true }).click();
    await expect.poll(() => queueTexts(page, botId), { timeout: 30_000 }).toEqual([]);
    const botText = async () =>
      (await rpc<ThreadSnapshot>(page, "threads/get", { botId })).messages
        .filter((message) => message.role === "bot")
        .flatMap((message) => message.blocks)
        .flatMap((block) => (block.kind === "text" ? [block.text] : []))
        .join("\n");
    await expect.poll(botText, { timeout: 30_000 }).toContain(revised);
    expect(await botText()).not.toContain(cancelled);
    await expect(queuePanel(page)).toBeHidden();
    await captureScreenshot(page, testInfo, "queue-consumed-after-approval");
  } finally {
    await rpc(page, "threads/stop", { botId }).catch(() => undefined);
  }
});

test("a second client's queue edit produces a conflict while preserving both local drafts", async ({
  page,
}, testInfo) => {
  const botId = await waitingConversation(page, "conflict");
  const original = "Prepare the original sample plan";
  const local = "Prepare the local sample plan";
  const remote = "Prepare the other client sample plan";
  try {
    await enqueue(page, original);
    const panel = await expandQueue(page);
    await composer(page).fill("An ordinary conversation draft");
    await rowFor(panel, original).getByRole("button", { name: "Edit", exact: true }).click();
    const editor = panel.getByRole("textbox", { name: "Edit queued message" });
    await editor.fill(local);
    const before = await readQueue(page, botId);
    await rpc(page, "threads/updateQueued", {
      botId,
      id: before.entries[0]!.id,
      revision: before.revision,
      text: remote,
    });
    const conflictResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/rpc/threads/updateQueued" &&
        response.request().method() === "POST",
    );
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    expect((await conflictResponse).status()).toBe(409);
    await expect(page.getByRole("alert").filter({ hasText: "The queue changed." })).toBeVisible();
    await expect(editor).toHaveValue(local);
    await expect(composer(page)).toHaveValue("An ordinary conversation draft");
    expect(await queueTexts(page, botId)).toEqual([remote]);
    await captureScreenshot(page, testInfo, "queue-conflict-preserves-drafts");
    await clickAndWaitForRpc(
      page,
      panel.getByRole("button", { name: "Save", exact: true }),
      "threads/updateQueued",
    );
    await expect.poll(() => queueTexts(page, botId)).toEqual([local]);
    await expect(editor).toBeHidden();
    await expect(composer(page)).toHaveValue("An ordinary conversation draft");
  } finally {
    await rpc(page, "threads/stop", { botId }).catch(() => undefined);
  }
});

test("switching conversations keeps the pending queue and ordinary draft with their bot", async ({
  page,
}, testInfo) => {
  const botId = await waitingConversation(page, "scope");
  try {
    await enqueue(page, "Prepare the first bot sample task");
    await composer(page).fill("Draft for the first bot");
    await createNamedBot(page, "Queue Neighbor");
    await expect(queuePanel(page)).toBeHidden();
    await expect(composer(page)).toHaveValue("");
    await composer(page).fill("Draft for the other bot");
    await page.goto(`/app/${botId}`);
    await expect(composer(page)).toHaveValue("Draft for the first bot");
    const panel = await expandQueue(page);
    await expect(panel.getByRole("listitem")).toHaveCount(1);
    await expect(panel.getByRole("listitem")).toContainText("Prepare the first bot sample task");
    await captureScreenshot(page, testInfo, "queue-conversation-scope");
  } finally {
    await rpc(page, "threads/stop", { botId }).catch(() => undefined);
  }
});
