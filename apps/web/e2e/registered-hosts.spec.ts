import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openNewBot, signup } from "./helpers";

test("registers a trusted host before creating a bot and exposes revocation", async ({
  page,
}, testInfo) => {
  await signup(page, `registered-host-${Date.now()}@rakazo.test`, "password12", "Host tester");
  await completeOnboarding(page);
  await openNewBot(page);
  const dialog = page.getByTestId("create-bot-dialog");
  await dialog.getByPlaceholder("Name your Bot").fill("Remote helper");
  await dialog.getByRole("button", { name: "Agent and environment" }).click();
  await dialog.getByLabel("Run on").selectOption("host");
  await dialog.getByRole("button", { name: "Register host", exact: true }).click();
  await dialog.getByLabel("Host name", { exact: true }).fill("Build host");
  await dialog.getByLabel("Host URL", { exact: true }).fill("https://host.example.test");
  await dialog.getByLabel("Host token", { exact: true }).fill("ab".repeat(32));
  const register = dialog.getByRole("button", { name: "Register", exact: true });
  await expect(register).toBeDisabled();
  await dialog.getByLabel("I trust this host to run commands and access project files.").check();
  await register.click();
  await expect(dialog.getByLabel("Host", { exact: true })).not.toHaveValue("");
  await expect(dialog.getByText("https://host.example.test", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Host token", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "registered-host-selected");
  await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("revoked");
  await captureScreenshot(page, testInfo, "registered-host-revoked");
});
