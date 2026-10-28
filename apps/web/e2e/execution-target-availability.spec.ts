import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

for (const provider of ["desktop", "docker"]) {
  test(`environment choices reflect ${provider} deployment`, async ({ page }, testInfo) => {
    await page.route("**/rpc/me", (route) =>
      route.fulfill({ json: { json: { sandboxProvider: provider } } }),
    );
    await page.route("**/rpc/hosts/list", (route) => route.fulfill({ json: { json: [] } }));
    await page.goto("/e2e/fixtures/create-bot-dialog.html");
    const dialog = page.getByTestId("create-bot-dialog");
    await dialog.getByRole("button", { name: "Agent and environment", exact: true }).click();
    const target = dialog.getByRole("combobox", { name: "Run on", exact: true });
    const docker = target.locator('option[value="docker"]');
    if (provider === "desktop") {
      await expect(docker).toHaveJSProperty("disabled", true);
      await expect(
        dialog.getByText("Docker is not enabled on this deployment.", { exact: true }),
      ).toBeVisible();
      await expect(target).toHaveValue("default");
      await target.selectOption("host");
      await expect(target).toHaveValue("host");
      await captureScreenshot(page, testInfo, "host-only-environment");
    } else {
      await expect(docker).toHaveJSProperty("disabled", false);
      await target.selectOption("docker");
      await expect(target).toHaveValue("docker");
      await expect(
        dialog.getByText("Docker is not enabled on this deployment.", { exact: true }),
      ).toHaveCount(0);
    }
  });
}
