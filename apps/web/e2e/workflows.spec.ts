import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("workflow canvas saves a dependency graph and opens its persisted editor", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signup(page, `workflow-${Date.now()}@example.test`, "password12", "Workflow QA");
  await completeOnboarding(page);
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/workflows$/);
  await page.getByLabel("Workflow name").fill("Review pipeline");
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page.getByLabel("Step name").fill("Research");
  await page.getByLabel("Instructions").fill("Inspect the project and summarize the findings.");
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page.getByLabel("Step name").fill("Review");
  await page.getByLabel("Instructions").fill("Review the findings from the research step.");
  await page.getByLabel("Run after", { exact: true }).selectOption({ label: "Research" });
  await page.getByRole("button", { name: "Add dependency", exact: true }).click();
  await expect(page.locator('path[marker-end="url(#workflow-arrow)"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await captureScreenshot(page, testInfo, "workflow-canvas");
  await page.reload();
  await page.getByRole("button", { name: "Review pipeline", exact: true }).click();
  await expect(page.getByLabel("Workflow name")).toHaveValue("Review pipeline");
  await expect(page.locator('path[marker-end="url(#workflow-arrow)"]')).toHaveCount(1);
});

test("workflow editor layout and save are available without executing tasks", async ({
  page,
}, testInfo) => {
  let saved = {
    id: "workflow-fixture",
    name: "Review pipeline",
    revision: 1,
    graph: {
      nodes: [
        {
          id: "research",
          label: "Research",
          botId: "bot",
          prompt: "Inspect the project.",
          x: 80,
          y: 40,
        },
        {
          id: "review",
          label: "Review",
          botId: "bot",
          prompt: "Review the findings.",
          x: 320,
          y: 220,
        },
      ],
      edges: [{ from: "research", to: "review" }],
    },
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  };
  let starts = 0;
  await page.route("**/rpc/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path.endsWith("/workflows/list")) json = { workflows: [saved] };
    else if (path.endsWith("/bots/list")) json = [{ id: "bot", name: "Writer" }];
    else if (path.endsWith("/workflows/runs")) json = { runs: [] };
    else if (path.endsWith("/workflows/save")) {
      saved = { ...saved, ...route.request().postDataJSON().json, revision: saved.revision + 1 };
      json = saved;
    } else if (path.endsWith("/workflows/start")) starts++;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ json }) });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e/fixtures/workflows.html");
  await page.getByRole("button", { name: "Review pipeline", exact: true }).click();
  const review = page.getByRole("button", { name: "Review", exact: true });
  await review.click();
  await page.getByLabel("Instructions").fill("Review the findings and identify any gaps.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  expect(starts).toBe(0);
  await captureScreenshot(page, testInfo, "workflow-editor-desktop");
  await review.press("ArrowRight");
  await expect(review).toHaveCSS("left", "340px");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "workflow-editor-mobile");
});
