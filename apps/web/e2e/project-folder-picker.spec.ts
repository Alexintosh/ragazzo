import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("project folder browsing selects explicitly and cancellation preserves the draft", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/hosts/list", (route) => route.fulfill({ json: { json: [] } }));
  await page.route("**/rpc/hosts/directories", (route) => {
    const input = route.request().postDataJSON().json;
    expect(input.hostId).toBeNull();
    const path = input.path ?? "/home/demo";
    return route.fulfill({
      json: {
        json: {
          path,
          parent: path === "/home/demo" ? null : "/home/demo",
          directories:
            path === "/home/demo" ? [{ name: "project", path: "/home/demo/project" }] : [],
          truncated: false,
        },
      },
    });
  });
  await page.goto("/e2e/fixtures/create-bot-dialog.html");
  const create = page.getByTestId("create-bot-dialog");
  await create.getByRole("button", { name: "Agent and environment", exact: true }).click();
  await create.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
  const field = create.getByLabel("Project folder", { exact: true });
  await field.fill("/home/demo");
  await create.getByRole("button", { name: "Browse", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Project folder", exact: true });
  await picker.getByRole("button", { name: "project", exact: true }).click();
  await expect(picker.getByLabel("Folder path", { exact: true })).toHaveValue("/home/demo/project");
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(create).toBeVisible();
  await expect(field).toHaveValue("/home/demo");
  await create.getByRole("button", { name: "Browse", exact: true }).click();
  await picker.getByRole("button", { name: "project", exact: true }).click();
  await expect(picker.getByRole("button", { name: "Use folder", exact: true })).toBeEnabled();
  await captureScreenshot(page, testInfo, "project-folder-picker");
  await picker.getByRole("button", { name: "Use folder", exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(create).toBeVisible();
  await expect(field).toHaveValue("/home/demo/project");
});
