import { describe, expect, it } from "vitest";
import { UpdateBotInput } from "./domain.js";

describe("operator tool-call limit", () => {
  it("keeps old clients unchanged and supports setting, clearing and comparing a limit", () => {
    expect(UpdateBotInput.parse({ botId: "bot" })).not.toHaveProperty("maxToolCallsPerTurn");
    expect(
      UpdateBotInput.parse({
        botId: "bot",
        maxToolCallsPerTurn: 3,
        expectedMaxToolCallsPerTurn: null,
      }),
    ).toMatchObject({ maxToolCallsPerTurn: 3, expectedMaxToolCallsPerTurn: null });
    expect(
      UpdateBotInput.parse({
        botId: "bot",
        maxToolCallsPerTurn: null,
        expectedMaxToolCallsPerTurn: 3,
      }),
    ).toMatchObject({ maxToolCallsPerTurn: null, expectedMaxToolCallsPerTurn: 3 });
  });
  it("requires a reviewed baseline before changing a limit", () => {
    expect(UpdateBotInput.safeParse({ botId: "bot", maxToolCallsPerTurn: 3 }).success).toBe(false);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 2147483648, "3"])("rejects an invalid limit %s", (value) => {
    expect(
      UpdateBotInput.safeParse({
        botId: "bot",
        maxToolCallsPerTurn: value,
        expectedMaxToolCallsPerTurn: null,
      }).success,
    ).toBe(false);
  });
});
