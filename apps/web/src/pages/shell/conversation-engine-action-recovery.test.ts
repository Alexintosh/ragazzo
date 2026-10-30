// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EngineActionRecovery } from "./conversation-engine-action-recovery";

beforeEach(() => sessionStorage.clear());
describe("durable Eros action recovery", () => {
  it("replays the original UUID after losing a completed action response and remounting", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Network lost"))
      .mockResolvedValue({ status: "completed", message: null });
    const first = new EngineActionRecovery("bot-one", sessionStorage, send);
    await expect(first.run(4, { kind: "event" })).rejects.toThrow("Network lost");
    const sent = send.mock.calls[0]![0];
    const remounted = new EngineActionRecovery("bot-one", sessionStorage, send);
    expect(remounted.unresolved).toBe(true);
    await expect(
      remounted.run(4, { kind: "open", occasion: "just_opened" }),
    ).resolves.toMatchObject({ status: "uncertain" });
    expect(send).toHaveBeenCalledTimes(1);
    await remounted.check();
    expect(send.mock.calls[1]![0]).toEqual(sent);
    expect(remounted.unresolved).toBe(false);
    expect(sessionStorage.length).toBe(0);
  });
  it("keeps uncertain actions and clears definitive admission failures", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ status: "uncertain", message: null })
      .mockRejectedValueOnce({ code: "BAD_REQUEST" });
    const recovery = new EngineActionRecovery("bot-one", sessionStorage, send);
    await recovery.run(0, { kind: "add_item", itemKind: "item", name: "Compass" });
    expect(recovery.unresolved).toBe(true);
    await expect(recovery.check()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(recovery.unresolved).toBe(false);
    expect(sessionStorage.length).toBe(0);
  });
  it("blocks malformed saved intents and unavailable storage before dispatch", async () => {
    const send = vi.fn();
    sessionStorage.setItem("rakazo:eros-action:bot-one", "{broken");
    const corrupt = new EngineActionRecovery("bot-one", sessionStorage, send);
    expect(corrupt.unresolved).toBe(true);
    await expect(corrupt.check()).rejects.toMatchObject({ code: "ACTION_RECOVERY_INVALID" });
    const unavailable = new EngineActionRecovery("bot-two", null, send);
    await expect(unavailable.run(0, { kind: "event" })).rejects.toMatchObject({
      code: "ACTION_RECOVERY_UNAVAILABLE",
    });
    expect(send).not.toHaveBeenCalled();
  });
});
