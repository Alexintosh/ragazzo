import { RunConversationEngineActionInput } from "@rakazo/contracts";
import { useMemo, useRef, useState } from "react";
import type { EngineAction, EngineActionOutcome } from "./conversation-engine-actions";

type PendingAction = { actionId: string; historyGeneration: number; action: EngineAction };
type Send = (request: PendingAction) => Promise<EngineActionOutcome>;
const PendingActionSchema = RunConversationEngineActionInput.omit({ botId: true }).strict();
const keyFor = (botId: string) => `rakazo:eros-action:${botId}`;
const definitive = (error: unknown) =>
  Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "BAD_REQUEST" || error.code === "CONFLICT"),
  );

/** Persist intent before dispatch so a lost response can only replay the same durable action. */
export class EngineActionRecovery {
  private pending: PendingAction | null = null;
  private blocked: "ACTION_RECOVERY_UNAVAILABLE" | "ACTION_RECOVERY_INVALID" | null = null;
  constructor(
    private botId: string,
    private storage: Storage | null,
    private send: Send,
  ) {
    try {
      if (!storage) {
        this.blocked = "ACTION_RECOVERY_UNAVAILABLE";
        return;
      }
      const stored = storage.getItem(keyFor(botId));
      if (stored) {
        try {
          this.pending = PendingActionSchema.parse(JSON.parse(stored));
        } catch {
          this.blocked = "ACTION_RECOVERY_INVALID";
        }
      }
    } catch {
      this.blocked = "ACTION_RECOVERY_UNAVAILABLE";
    }
  }
  get unresolved() {
    return this.pending !== null || this.blocked !== null;
  }
  async run(historyGeneration: number, action: EngineAction) {
    if (this.blocked) throw { code: this.blocked };
    if (this.pending) return { status: "uncertain" as const, message: null };
    const pending = { actionId: crypto.randomUUID(), historyGeneration, action };
    try {
      this.storage!.setItem(keyFor(this.botId), JSON.stringify(pending));
    } catch {
      this.blocked = "ACTION_RECOVERY_UNAVAILABLE";
      throw { code: this.blocked };
    }
    this.pending = pending;
    return this.check();
  }
  async check(): Promise<EngineActionOutcome> {
    if (this.blocked) throw { code: this.blocked };
    if (!this.pending) return { status: "completed", message: null };
    try {
      const result = await this.send(this.pending);
      if (result.status === "completed") this.clear();
      return result;
    } catch (error) {
      if (definitive(error)) this.clear();
      throw error;
    }
  }
  private clear() {
    this.storage!.removeItem(keyFor(this.botId));
    this.pending = null;
  }
}

function safeSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function useEngineActionRecovery(botId: string, send: Send) {
  const latestSend = useRef(send);
  latestSend.current = send;
  const recovery = useMemo(
    () =>
      new EngineActionRecovery(botId, safeSessionStorage(), (request) =>
        latestSend.current(request),
      ),
    [botId],
  );
  const [, rerender] = useState(0);
  async function update(run: () => Promise<EngineActionOutcome>) {
    try {
      return await run();
    } finally {
      rerender((value) => value + 1);
    }
  }
  return {
    unresolved: recovery.unresolved,
    run: (historyGeneration: number, action: EngineAction) =>
      update(() => recovery.run(historyGeneration, action)),
    check: () => update(() => recovery.check()),
  };
}
