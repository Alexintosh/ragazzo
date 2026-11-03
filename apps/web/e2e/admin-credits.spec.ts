import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

async function makeAdmin(route: Route, bootstrap: boolean) {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  const me = bootstrap ? body.json?.me : body.json;
  if (me && typeof me === "object") Object.assign(me, { isAdmin: true });
  await route.fulfill({ response, json: body });
}

test("deployment admin manages credits and reviews cost uncertainty", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `credit-admin-${stamp}@rakazo.test`, "password12", "Credit Admin");
  await completeOnboarding(page);
  await page.route("**/rpc/me", (route) => makeAdmin(route, false));
  await page.route("**/rpc/bootstrap", (route) => makeAdmin(route, true));
  let balance = "120000";
  const adjustments: unknown[] = [];
  const replies: Record<string, unknown> = {
    overview: { accountCount: 1, balanceMicros: balance, pendingCount: 1, pendingMicros: "2000" },
    policy: {
      enabled: true,
      defaultDailyAllowanceMicros: "10000",
      dailyGrantBudgetMicros: "100000",
    },
    tariffs: [{ provider: "example", model: "example-model", multiplierBps: 15000 }],
    journal: {
      events: [
        {
          id: "event-1",
          kind: "adjustment",
          organizationId: "org-sample",
          amountMicros: "120000",
          provider: null,
          model: null,
          actorId: "deployment-admin",
          reason: "Welcome grant",
          createdAt: "2026-11-01T09:00:00.000Z",
        },
      ],
      nextCursor: null,
    },
    costReport: {
      from: "2026-11-01",
      to: "2026-11-02",
      rows: [
        {
          provider: "example",
          model: "example-model",
          providerCostUsd: 0.01,
          chargedMicros: "15000",
          pendingMicros: "2000",
          knownCostCount: 1,
          unknownCostCount: 2,
          pendingCount: 1,
        },
      ],
    },
  };
  await page.route("**/rpc/creditAdmin/*", async (route) => {
    const method = route.request().url().split("/").at(-1)!;
    if (method === "accounts") {
      await route.fulfill({
        json: {
          json: {
            accounts: [
              {
                organizationId: "org-sample",
                name: "Sample workspace",
                mode: "credits",
                balanceMicros: balance,
                dailyAllowanceMicros: null,
              },
            ],
            nextCursor: null,
          },
        },
      });
    } else if (method === "adjustment") {
      const input = route.request().postDataJSON().json as { amountMicros: string };
      adjustments.push(input);
      balance = (BigInt(balance) + BigInt(input.amountMicros)).toString();
      await route.fulfill({ json: { json: { ok: true } } });
    } else await route.fulfill({ json: { json: replies[method] } });
  });

  await page.goto("/admin/credits");
  const panel = page.getByTestId("admin-credits");
  await expect(panel.getByRole("heading", { name: "Hosted credit policy" })).toBeVisible();
  await expect(panel.getByRole("columnheader", { name: "Unknown cost" })).toBeVisible();
  await captureScreenshot(page, testInfo, "admin-credits");
  await panel.getByRole("button", { name: "Manage", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sample workspace" });
  await dialog.getByRole("textbox", { name: "Credit adjustment" }).fill("-12.345");
  await dialog
    .getByRole("textbox", { name: "Reason", exact: true })
    .first()
    .fill("Duplicate welcome grant");
  await dialog.getByRole("button", { name: "Review revocation" }).click();
  await expect(dialog.getByText("Revoke 12.345 credits from Sample workspace?")).toBeVisible();
  expect(adjustments).toHaveLength(0);
  await captureScreenshot(page, testInfo, "admin-credits-revoke");
  await dialog.getByRole("button", { name: "Confirm revocation" }).click();
  await expect(dialog.getByRole("status")).toContainText("Adjustment recorded");
  expect(adjustments).toEqual([
    {
      organizationId: "org-sample",
      amountMicros: "-12345",
      reason: "Duplicate welcome grant",
      idempotencyKey: expect.any(String),
    },
  ]);
});
