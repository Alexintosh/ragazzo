import { describe, expect, it } from "vitest";
import { BotSchema, SetBotExecutionInput } from "./domain.js";

describe("bot execution contract", () => {
  it("keeps older bot payloads on Pi with unchanged placement", () => {
    expect(BotSchema.shape.runtimeKind.parse(undefined)).toBe("pi");
    expect(BotSchema.shape.executionTarget.parse(undefined)).toBe("default");
    expect(BotSchema.shape.runtimePermission.parse(undefined)).toBe("workspace");
    expect(BotSchema.shape.projectPath.parse(undefined)).toBeNull();
  });

  it("requires an explicit complete execution update", () => {
    expect(SetBotExecutionInput.safeParse({ botId: "bot", runtimeKind: "codex" }).success).toBe(
      false,
    );
    expect(
      SetBotExecutionInput.safeParse({
        botId: "bot",
        runtimeKind: "codex",
        executionTarget: "host",
        runtimePermission: "workspace",
        projectPath: "/project",
      }).success,
    ).toBe(true);
    expect(
      SetBotExecutionInput.safeParse({
        botId: "bot",
        runtimeKind: "shell",
        executionTarget: "host",
        runtimePermission: "workspace",
        projectPath: "/project",
      }).success,
    ).toBe(false);
  });
});
