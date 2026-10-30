import { describe, expect, it } from "vitest";
import { conversationEngineTurnSettings } from "./conversation-engine-executor.js";

describe("conversation engine request snapshots", () => {
  it("leaves legacy requests without options and reads the persisted settings exactly", () => {
    expect(conversationEngineTurnSettings(null)).toBeUndefined();
    expect(conversationEngineTurnSettings(undefined)).toBeUndefined();
    expect(
      conversationEngineTurnSettings({
        version: 1,
        settings: { tier: "advanced", outfit: "Coat", memoryScope: "none" },
      }),
    ).toEqual({ tier: "advanced", outfit: "Coat", memoryScope: "none" });
  });

  it("rejects unsupported snapshots before submission", () => {
    expect(() => conversationEngineTurnSettings({ version: 2, settings: {} })).toThrow();
    expect(() =>
      conversationEngineTurnSettings({ version: 1, settings: { baseUrl: "invalid" } }),
    ).toThrow();
  });
});
