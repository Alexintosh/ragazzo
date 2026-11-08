import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { ConversationTask, ThreadQueue, ThreadSnapshot } from "@rakazo/contracts";
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
const taskPanel = (page: Page) => page.getByTestId("conversation-tasks");
async function expandTasks(page: Page) {
  const panel = taskPanel(page);
  await expect(panel).toBeVisible();
  if (!(await panel.evaluate((element) => (element as HTMLDetailsElement).open)))
    await panel.locator("summary").click();
  return panel;
}
async function currentTask(page: Page) {
  const taskId = new URL(page.url()).pathname.split("/").at(-1);
  return rpc<ConversationTask>(page, "tasks/get", { taskId });
}

test("task approvals and stop stay in their conversation, with deliberate recovery on another bot", async ({
  page,
}, testInfo) => {
  await signup(page, `tasks-recover-${Date.now()}@rakazo.test`, "password12", "Task Example");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const otherBotId = await createNamedBot(page, "Reviewer");
  await page.goto(`/app/${botId}`);
  const before = await rpc<ThreadSnapshot>(page, "threads/get", { botId });
  let task: ConversationTask | undefined;
  let recovery: ConversationTask | undefined;
  try {
    const panel = await expandTasks(page);
    await panel.getByRole("button", { name: "New task", exact: true }).click();
    await panel
      .getByRole("textbox", { name: "Task instructions" })
      .fill("ask me which city to use");
    await clickAndWaitForRpc(
      page,
      panel.getByRole("button", { name: "Start task", exact: true }),
      "tasks/create",
    );
    await expect(page).toHaveURL(/\/tasks\//);
    task = await currentTask(page);
    expect(task.threadId).not.toBe(before.threadId);
    await expect
      .poll(
        async () =>
          (await rpc<ThreadSnapshot>(page, "threads/get", { taskId: task!.id })).run?.status,
      )
      .toBe("waiting_input");
    await expect(
      page.locator("p").filter({ hasText: /^Which city should I use\?$/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Edit first", exact: true }).click();
    await page.getByRole("textbox", { name: "Answer", exact: true }).fill("Paris");
    await clickAndWaitForRpc(
      page,
      page.getByRole("button", { name: "Send answer", exact: true }),
      "threads/answer",
    );
    await expect
      .poll(
        async () => (await rpc<ConversationTask>(page, "tasks/get", { taskId: task!.id })).status,
      )
      .toBe("completed");
    expect((await rpc<ThreadSnapshot>(page, "threads/get", { botId })).messages).toEqual(
      before.messages,
    );
    await composer(page).fill("ask me which city to use");
    await composer(page).press("Enter");
    await expect
      .poll(
        async () =>
          (await rpc<ThreadSnapshot>(page, "threads/get", { taskId: task!.id })).run?.status,
      )
      .toBe("waiting_input");
    await clickAndWaitForRpc(
      page,
      page.getByRole("button", { name: "Stop", exact: true }),
      "threads/stop",
    );
    await expect
      .poll(
        async () => (await rpc<ConversationTask>(page, "tasks/get", { taskId: task!.id })).status,
      )
      .toBe("cancelled");
    const recoveryPanel = await expandTasks(page);
    await recoveryPanel
      .getByRole("button", { name: "Recover or reassign", exact: true })
      .first()
      .click();
    await expect(recoveryPanel).toContainText("Earlier actions may already have taken effect");
    await recoveryPanel
      .getByRole("combobox", { name: "Task bot", exact: true })
      .selectOption(otherBotId);
    await recoveryPanel
      .getByRole("textbox", { name: "Task instructions" })
      .fill("ask me which city to use after reviewing earlier work");
    await captureScreenshot(page, testInfo, "task-recovery-reviewed");
    await clickAndWaitForRpc(
      page,
      recoveryPanel.getByRole("button", { name: "Start recovery", exact: true }),
      "tasks/recover",
    );
    await expect(page).not.toHaveURL(new RegExp(`/tasks/${task.id}$`));
    recovery = await currentTask(page);
    expect(recovery.botId).toBe(otherBotId);
    expect(recovery.recoveryOfRunId).not.toBeNull();
    await expandTasks(page);
    await expect(taskPanel(page)).toContainText("Recovery");
    await page.reload();
    await expandTasks(page);
    await expect(taskPanel(page)).toContainText("after reviewing earlier work");
    await captureScreenshot(page, testInfo, "task-recovery-conversation");
    await taskPanel(page).getByRole("button", { name: "Source conversation", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
    await expandTasks(page);
    await taskPanel(page)
      .getByRole("button", { name: "Open recovery", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${recovery.id}$`));
    expect((await rpc<ThreadSnapshot>(page, "threads/get", { botId })).messages).toEqual(
      before.messages,
    );
  } finally {
    if (task) await rpc(page, "threads/stop", { taskId: task.id }).catch(() => undefined);
    if (recovery) await rpc(page, "threads/stop", { taskId: recovery.id }).catch(() => undefined);
  }
});

test("queued text moves into a separate task without stopping its source approval", async ({
  page,
}, testInfo) => {
  await signup(page, `tasks-queue-${Date.now()}@rakazo.test`, "password12", "Queue Task Example");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  let task: ConversationTask | undefined;
  try {
    await composer(page).fill("ask me which city to use");
    await composer(page).press("Enter");
    await expect
      .poll(async () => (await rpc<ThreadSnapshot>(page, "threads/get", { botId })).run?.status)
      .toBe("waiting_input");
    await composer(page).fill("Prepare the standalone task example");
    await clickAndWaitForRpc(
      page,
      page.getByRole("button", { name: "Queue", exact: true }),
      "threads/enqueue",
    );
    const queue = page.getByTestId("thread-queue");
    await queue.locator("summary").click();
    await clickAndWaitForRpc(
      page,
      queue.getByRole("button", { name: "Start as task", exact: true }),
      "tasks/startQueued",
    );
    await expect(page).toHaveURL(/\/tasks\//);
    task = await currentTask(page);
    expect(task.prompt).toBe("Prepare the standalone task example");
    expect((await rpc<ThreadQueue>(page, "threads/queue", { botId })).entries).toEqual([]);
    expect((await rpc<ThreadSnapshot>(page, "threads/get", { botId })).run?.status).toBe(
      "waiting_input",
    );
    await expandTasks(page);
    await captureScreenshot(page, testInfo, "queued-message-task-conversation");
    await rpc(page, "threads/stop", { botId });
    await expect
      .poll(
        async () => (await rpc<ConversationTask>(page, "tasks/get", { taskId: task!.id })).status,
      )
      .toBe("completed");
    await expect(
      page
        .locator("p")
        .filter({ hasText: /Prepare the standalone task example/ })
        .first(),
    ).toBeVisible();
  } finally {
    await rpc(page, "threads/stop", { botId }).catch(() => undefined);
    if (task) await rpc(page, "threads/stop", { taskId: task.id }).catch(() => undefined);
  }
});
