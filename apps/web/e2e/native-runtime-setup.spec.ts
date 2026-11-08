import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("native runtime creation exposes a local-consent setup plan", async ({ page }, testInfo) => {
  const status = {
    kind: "codex",
    available: false,
    authenticated: false,
    managed: false,
    installSupported: true,
    loginSupported: true,
  };
  let planned = false;
  await page.route("**/rpc/hosts/list", (route) => route.fulfill({ json: { json: [] } }));
  await page.route("**/rpc/nativeSetup/request", async (route) => {
    const body = route.request().postDataJSON() as { json?: { action?: string } };
    if (body.json?.action === "install") planned = true;
    await route.fulfill({
      json: {
        json: {
          ...status,
          ...(planned
            ? {
                session: {
                  id: "11111111-1111-4111-8111-111111111111",
                  action: "install",
                  state: "awaiting-consent",
                  expiresAt: "2099-01-01T00:00:00.000Z",
                  command: [
                    "npm",
                    "install",
                    "--prefix",
                    "/host-data/native-tools/codex",
                    "--ignore-scripts",
                    "@openai/codex",
                  ],
                  destination: "/host-data/native-tools/codex",
                  localApproval:
                    "pnpm host:setup --data-dir /host-data --session 11111111-1111-4111-8111-111111111111",
                },
              }
            : {}),
        },
      },
    });
  });
  await page.goto("/e2e/fixtures/create-bot-dialog.html");
  await page.getByRole("button", { name: "Agent and environment", exact: true }).click();
  await page.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
  await page.getByRole("button", { name: "Set up runtime", exact: true }).click();
  await page.getByRole("button", { name: "Prepare install", exact: true }).click();
  await expect(page.getByText("Approve in the host terminal", { exact: true })).toBeVisible();
  await expect(page.getByText(/pnpm host:setup --data-dir/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel setup", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "native-runtime-local-consent");
});
