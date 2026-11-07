import { FARMING_CONTROL_RISK_SELECTION_LIMIT } from "@rakazo/contracts";
import type { ComposerMentionBinding } from "@rakazo/core";
import { validateComposerMentionBindings } from "@rakazo/core";
import { upgradeLegacyFarmingRiskDraft } from "./farming-risk-draft";

export const COMPOSER_DRAFT_STORAGE_PREFIX = "rakazo.composerDraft.";
const COMPOSER_BINDINGS_STORAGE_PREFIX = "rakazo.composerBindings.";

type ComposerDraftSubmission = { text: string; bindingRecord: string | null };
const pendingSubmissions = new Map<string, ComposerDraftSubmission>();
const acceptedListeners = new Map<string, Set<(text: string) => void>>();

export function beginComposerDraftSubmission(
  threadKey: string,
  text: string,
): ComposerDraftSubmission {
  writeComposerDraft(threadKey, text);
  const submission = { text, bindingRecord: readBindingRecord(threadKey) };
  pendingSubmissions.set(threadKey, submission);
  return submission;
}

export function settleComposerDraftSubmission(
  threadKey: string,
  submission: ComposerDraftSubmission,
  accepted: boolean,
): void {
  if (pendingSubmissions.get(threadKey) !== submission) return;
  pendingSubmissions.delete(threadKey);
  if (
    !accepted ||
    readComposerDraft(threadKey) !== submission.text ||
    readBindingRecord(threadKey) !== submission.bindingRecord
  )
    return;
  writeComposerDraft(threadKey, "");
  for (const listener of acceptedListeners.get(threadKey) ?? []) listener(submission.text);
}

let unsavedWork = false;

/**
 * The shell reports work a reload would lose: a send (typed or spoken) until the server answers,
 * or picked attachments, which live only in memory.
 */
export function setComposerUnsavedWork(pending: boolean): void {
  unsavedWork = pending;
}

/** A send waiting for its answer, or attachments that only exist in memory. */
export function composerHoldsUnsavedWork(): boolean {
  return pendingSubmissions.size > 0 || unsavedWork;
}

/** Unsaved composer work, or saved text in any composer that has not been sent. */
export function hasUnsentComposerDraft(storage: Storage | null = null): boolean {
  if (composerHoldsUnsavedWork()) return true;
  try {
    const drafts = storage ?? localStorage;
    for (let index = 0; index < drafts.length; index++) {
      const key = drafts.key(index);
      if (key?.startsWith(COMPOSER_DRAFT_STORAGE_PREFIX) && drafts.getItem(key)) return true;
    }
  } catch {
    // Without storage the draft lives only in memory, so treat it as unsent.
    return true;
  }
  return false;
}

export function subscribeComposerDraftAccepted(
  threadKey: string,
  listener: (text: string) => void,
): () => void {
  let listeners = acceptedListeners.get(threadKey);
  if (!listeners) {
    listeners = new Set();
    acceptedListeners.set(threadKey, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) acceptedListeners.delete(threadKey);
  };
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function getLocalStorage(): DraftStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function composerDraftStorageKey(threadKey: string): string {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}${threadKey}`;
}

export function composerDraftBindingsKey(threadKey: string): string {
  return `${COMPOSER_BINDINGS_STORAGE_PREFIX}${threadKey}`;
}

function readBindingRecord(threadKey: string, storage = getLocalStorage()): string | null {
  try {
    return storage?.getItem(composerDraftBindingsKey(threadKey)) ?? null;
  } catch {
    return null;
  }
}

/** Bindings are optional metadata; a stale record must never replace the raw text. */
export function readComposerDraftBindings(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): ComposerMentionBinding[] {
  if (!storage || !threadKey) return [];
  const key = composerDraftBindingsKey(threadKey);
  try {
    const raw = readBindingRecord(threadKey, storage);
    if (!raw) return [];
    const record = JSON.parse(raw);
    const text = readComposerDraft(threadKey, storage);
    if (record?.version !== 1 || record.text !== text) {
      storage.removeItem(key);
      return [];
    }
    return validateComposerMentionBindings(text, record.bindings);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* The in-memory draft remains usable. */
    }
    return [];
  }
}

export function readComposerDraft(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): string {
  if (!storage || !threadKey) return "";
  try {
    return storage.getItem(composerDraftStorageKey(threadKey)) ?? "";
  } catch {
    return "";
  }
}

/** Upgrade only recognized app-generated Risk draft blocks when a composer is opened. */
export function prepareComposerDraft(
  threadKey: string,
  storage: DraftStorage | null = getLocalStorage(),
): { text: string; bindings: ComposerMentionBinding[] } {
  const text = readComposerDraft(threadKey, storage);
  const bindings = readComposerDraftBindings(threadKey, storage);
  // Risk card handoffs are private specialist drafts, never group/history messages.
  if (!/^bot:fc-specialist:.+:risk$/.test(threadKey)) return { text, bindings };
  const prepared = upgradeLegacyFarmingRiskDraft(text, bindings);
  const riskTags = new Set(
    prepared.bindings
      .filter((binding) => binding.mention.kind === "farming-risk")
      .map((binding) => binding.mention.id),
  );
  if (riskTags.size > FARMING_CONTROL_RISK_SELECTION_LIMIT) return { text, bindings };
  if (
    prepared.text !== text &&
    !writeVerifiedComposerDraft(threadKey, prepared.text, storage, prepared.bindings)
  )
    return { text, bindings };
  return prepared;
}

/** Verify persisted chip identities and offsets as well as the visible draft. */
export function composerDraftMatches(
  threadKey: string,
  text: string,
  bindings: readonly ComposerMentionBinding[],
  storage: DraftStorage | null = getLocalStorage(),
): boolean {
  const expected = validateComposerMentionBindings(text, bindings);
  return (
    storage !== null &&
    readComposerDraft(threadKey, storage) === text &&
    expected.length === bindings.length &&
    JSON.stringify(readComposerDraftBindings(threadKey, storage)) === JSON.stringify(expected)
  );
}

/** Handoffs and migrations require durable text and chip metadata together. */
export function writeVerifiedComposerDraft(
  threadKey: string,
  draft: string,
  storage: DraftStorage | null = getLocalStorage(),
  bindings?: readonly ComposerMentionBinding[],
): boolean {
  pendingSubmissions.delete(threadKey);
  if (!storage || !threadKey) return false;
  const draftKey = composerDraftStorageKey(threadKey);
  const bindingKey = composerDraftBindingsKey(threadKey);
  let previousDraft: string | null;
  let previousBindings: string | null;
  try {
    previousDraft = storage.getItem(draftKey);
    previousBindings = storage.getItem(bindingKey);
  } catch {
    return false;
  }
  // Unchanged plain-text resubmissions retain their existing identities.
  const bindingRecord =
    bindings === undefined && draft && draft === previousDraft
      ? previousBindings
      : bindings?.length && draft
        ? JSON.stringify({ version: 1, text: draft, bindings })
        : null;
  if (bindings && validateComposerMentionBindings(draft, bindings).length !== bindings.length)
    return false;
  const restore = (key: string, value: string | null) => {
    try {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    } catch {
      // A denied storage operation must not prevent restoring the other record.
    }
  };
  try {
    // Metadata first: quota failures must not replace a legacy draft with a bare token.
    if (bindingRecord === null) storage.removeItem(bindingKey);
    else storage.setItem(bindingKey, bindingRecord);
    if (draft.length === 0) storage.removeItem(draftKey);
    else storage.setItem(draftKey, draft);
    if (
      storage.getItem(draftKey) !== (draft || null) ||
      storage.getItem(bindingKey) !== bindingRecord
    )
      throw new Error("Composer draft storage did not retain the complete draft");
    return true;
  } catch {
    restore(draftKey, previousDraft);
    restore(bindingKey, previousBindings);
    return false;
  }
}

export function writeComposerDraft(
  threadKey: string,
  draft: string,
  storage: DraftStorage | null = getLocalStorage(),
  bindings?: readonly ComposerMentionBinding[],
): void {
  pendingSubmissions.delete(threadKey);
  if (!storage || !threadKey) return;
  try {
    // Plain-text callers preserve bindings only when they are resubmitting the
    // unchanged draft. New text without bindings cannot inherit old identities.
    if (bindings !== undefined || draft !== readComposerDraft(threadKey, storage) || !draft) {
      storage.removeItem(composerDraftBindingsKey(threadKey));
    }
    if (draft.length === 0) storage.removeItem(composerDraftStorageKey(threadKey));
    else storage.setItem(composerDraftStorageKey(threadKey), draft);
    if (bindings?.length && draft) {
      storage.setItem(
        composerDraftBindingsKey(threadKey),
        JSON.stringify({ version: 1, text: draft, bindings }),
      );
    }
  } catch {
    // Quota or private-mode failures: the draft still lives in memory.
  }
}
