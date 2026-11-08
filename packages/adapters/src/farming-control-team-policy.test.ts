import { FARMING_CONTROL_GRANTS } from "@rakazo/core";
import { expect, it } from "vitest";
import {
  FARMING_CONTROL_ROLES,
  FARMING_CONTROL_SAFE_TOOLS,
  farmingControlSafeToolsForRole,
  farmingControlToolsForRole,
} from "./farming-control-team-policy.js";

it("offers native consultation messaging to Coordinator only", () => {
  for (const role of FARMING_CONTROL_ROLES) {
    const tools = farmingControlSafeToolsForRole(role);
    expect(tools.has("message_bot")).toBe(role === "coordinator");
    expect([...tools].filter((tool) => tool !== "message_bot")).toEqual([
      ...FARMING_CONTROL_SAFE_TOOLS,
    ]);
    expect(tools.has("shell")).toBe(false);
    expect(tools.has("web_fetch")).toBe(false);
    expect(tools.has("run_subagent")).toBe(false);
  }
});

it("gives Coordinator read-only Intelligence while keeping writes confined to Opportunities", () => {
  for (const role of FARMING_CONTROL_ROLES) {
    const tools = farmingControlToolsForRole(role);
    const intelligence = tools.find((tool) => tool.name === "farming_control_intelligence");
    expect(Boolean(intelligence)).toBe(role === "coordinator" || role === "opportunities");
    expect(FARMING_CONTROL_GRANTS[role].includes("intelligence")).toBe(Boolean(intelligence));
    if (intelligence) expect(intelligence.readOnly).toBe(true);
    for (const name of [
      "farming_control_opportunity_publish",
      "farming_control_recommendation_feedback",
    ]) {
      expect(tools.some((tool) => tool.name === name)).toBe(role === "opportunities");
    }
    if (role === "coordinator") expect(tools.every((tool) => tool.readOnly)).toBe(true);
  }
});
