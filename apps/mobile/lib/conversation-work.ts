import type { RpcOutput, RpcPath, ThreadQueue } from "@rakazo/contracts";
import type { WaitingPresentation } from "@rakazo/core";
import type { ApiRequestContext, RpcArgs } from "./api";
import {
  captureApiRequestContext,
  currentApiBase,
  rpc,
  selectedSpaceId,
  spaceSelectionSeq,
} from "./api";
import { t } from "./i18n";
import { currentSessionGeneration } from "./session";

/** A delayed queue receipt must not replace a newer revision from a refresh. */
export function latestQueue(current: ThreadQueue | null, incoming: ThreadQueue): ThreadQueue {
  return current && current.revision > incoming.revision ? current : incoming;
}

export function waitingLabel(waiting: WaitingPresentation): string {
  switch (waiting.reason) {
    case "question":
      return t("Waiting for answer");
    case "approval":
      return t("Waiting for approval");
    case "secret":
      return t("Waiting for secret");
    case "takeover":
    case "computer":
      return t("Waiting for computer");
    case "waiting":
      return t("Waiting");
    case "running":
      return t("Waiting for current work");
    case "ready":
      return t("Ready");
  }
}

export function waitingActionLabel(waiting: WaitingPresentation): string {
  switch (waiting.action) {
    case "answer":
      return t("Answer");
    case "review_approval":
      return t("Review approval");
    case "provide_secret":
      return t("Provide secret");
    case "takeover":
      return t("Take over");
    default:
      return "";
  }
}

export function moveQueued(queue: ThreadQueue, id: string, direction: -1 | 1): string[] {
  const ids = queue.entries.map((entry) => entry.id);
  const from = ids.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  return ids;
}

/** Bind a multi-step native interaction to the account and Space where it began. */
export function createConversationRequest() {
  const origin = JSON.stringify([
    currentApiBase(),
    selectedSpaceId(),
    spaceSelectionSeq(),
    currentSessionGeneration(),
  ]);
  const isCurrent = () =>
    origin ===
    JSON.stringify([
      currentApiBase(),
      selectedSpaceId(),
      spaceSelectionSeq(),
      currentSessionGeneration(),
    ]);
  let context: Promise<ApiRequestContext> | undefined;
  async function request<P extends RpcPath>(
    proc: P,
    ...[body, options]: RpcArgs<P>
  ): Promise<RpcOutput<P>> {
    if (!isCurrent()) throw new Error(t("Conversation changed. Reopen it to continue."));
    context ??= captureApiRequestContext();
    const requestContext = await context;
    if (!isCurrent()) throw new Error(t("Conversation changed. Reopen it to continue."));
    const result = await rpc(proc, ...([body, { ...options, requestContext }] as RpcArgs<P>));
    if (!isCurrent()) throw new Error(t("Conversation changed. Reopen it to continue."));
    return result;
  }
  return Object.assign(request, { isCurrent });
}
