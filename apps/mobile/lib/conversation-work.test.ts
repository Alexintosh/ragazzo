import type { ThreadQueue } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  spaceId: "space-a",
  selection: 0,
  session: 1,
  apiBase: "https://api.example.test",
  rpc: vi.fn(),
}));
vi.mock("./api", () => ({
  currentApiBase: () => state.apiBase,
  selectedSpaceId: () => state.spaceId,
  spaceSelectionSeq: () => state.selection,
  captureApiRequestContext: async () => ({
    apiBase: state.apiBase,
    sessionGeneration: state.session,
    headers: { "x-rakazo-space-id": state.spaceId },
  }),
  rpc: state.rpc,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => state.session }));
vi.mock("./i18n", () => ({ t: (value: string) => value }));

import { queueWaiting } from "@rakazo/core";
import {
  createConversationRequest,
  latestQueue,
  moveQueued,
  waitingActionLabel,
  waitingLabel,
} from "./conversation-work";

beforeEach(() => {
  state.spaceId = "space-a";
  state.selection = 0;
  state.session = 1;
  state.apiBase = "https://api.example.test";
  state.rpc.mockReset().mockResolvedValue({ ok: true });
});

const queue = (revision: number, ids: string[]): ThreadQueue => ({
  revision,
  canSteer: true,
  waitingReason: "running",
  entries: ids.map((id, position) => ({
    id,
    messageId: `message-${id}`,
    botId: "bot-a",
    botName: "Bot",
    text: id,
    position,
    canSteer: true,
  })),
});

describe("native conversation work", () => {
  it("accepts changed waiting detail on an equal-revision reread and removes the stale button", () => {
    const question: ThreadQueue = {
      ...queue(4, []),
      waitingReason: "approval",
      waitingDetail: { reason: "question", runId: "run", messageId: "ask", action: "answer" },
    };
    expect(waitingLabel(queueWaiting(question))).toBe("Waiting for answer");
    expect(waitingActionLabel(queueWaiting(question))).toBe("Answer");
    const answered = { ...question, waitingDetail: { reason: "waiting" as const, runId: "run" } };
    const current = latestQueue(question, answered);
    expect(current).toBe(answered);
    expect(waitingActionLabel(queueWaiting(current))).toBe("");
    expect(waitingLabel(queueWaiting(current))).toBe("Waiting");
  });
  it("keeps old-server fallbacks and server-denied takeover non-actionable", () => {
    expect(waitingLabel(queueWaiting({ ...queue(1, []), waitingReason: "approval" }))).toBe(
      "Waiting for approval",
    );
    expect(waitingActionLabel(queueWaiting(queue(1, [])))).toBe("");
    expect(
      waitingActionLabel(
        queueWaiting({
          ...queue(1, []),
          waitingDetail: { reason: "takeover", runId: "run", messageId: "computer" },
        }),
      ),
    ).toBe("");
  });
  it("keeps queue order from a newer poll when an older mutation receipt arrives", () => {
    const newer = queue(4, ["second", "first"]);
    expect(latestQueue(newer, queue(3, ["first", "second"]))).toBe(newer);
    expect(moveQueued(newer, "first", -1)).toEqual(["first", "second"]);
    expect(newer.entries.map((entry) => entry.id)).toEqual(["second", "first"]);
  });
  it("does not wrap a queued item past either end or invent missing entries", () => {
    const current = queue(2, ["a", "b"]);
    expect(moveQueued(current, "a", -1)).toEqual(["a", "b"]);
    expect(moveQueued(current, "b", 1)).toEqual(["a", "b"]);
    expect(moveQueued(current, "missing", 1)).toEqual(["a", "b"]);
  });
  it("binds multi-step mutations to captured request headers", async () => {
    const request = createConversationRequest();
    await request("threads/stop", { taskId: "task-a" });
    expect(state.rpc).toHaveBeenCalledWith(
      "threads/stop",
      { taskId: "task-a" },
      {
        requestContext: {
          apiBase: "https://api.example.test",
          sessionGeneration: 1,
          headers: { "x-rakazo-space-id": "space-a" },
        },
      },
    );
  });
  it("rejects a late mutation receipt after a Space changes, including A to B to A", async () => {
    let resolve!: (value: unknown) => void;
    state.rpc.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const request = createConversationRequest();
    const pending = request("threads/stop", { taskId: "task-a" });
    await vi.waitFor(() => expect(state.rpc).toHaveBeenCalledOnce());
    state.spaceId = "space-b";
    state.selection++;
    state.spaceId = "space-a";
    state.selection++;
    resolve({ ok: true });
    await expect(pending).rejects.toThrow("Conversation changed");
    await expect(request("threads/stop", { taskId: "task-a" })).rejects.toThrow(
      "Conversation changed",
    );
    expect(state.rpc).toHaveBeenCalledOnce();
  });
  it.each(["session", "endpoint"])(
    "does not start another step after the %s changes",
    async (change) => {
      const request = createConversationRequest();
      await request("threads/stop", { taskId: "task-a" });
      if (change === "session") state.session++;
      else state.apiBase = "https://other.example.test";
      await expect(request("threads/stop", { taskId: "task-a" })).rejects.toThrow(
        "Conversation changed",
      );
      expect(state.rpc).toHaveBeenCalledOnce();
    },
  );
});
