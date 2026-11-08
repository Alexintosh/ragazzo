export type FarmingControlChatPlacement = "sidebar" | "main";

export const FARMING_CONTROL_CHAT_PLACEMENT_STORAGE_KEY = "rakazo.farmingControlChatPlacement";

type PlacementStorage = Pick<Storage, "getItem" | "setItem">;

const listeners = new Set<() => void>();
let memoryPreference: FarmingControlChatPlacement | null = null;

function getLocalStorage(): PlacementStorage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function normalizeFarmingControlChatPlacement(
  raw: string | null | undefined,
): FarmingControlChatPlacement {
  return raw?.trim().toLowerCase() === "main" ? "main" : "sidebar";
}

export function readFarmingControlChatPlacement(
  storage: Pick<Storage, "getItem"> | null = getLocalStorage(),
): FarmingControlChatPlacement {
  if (!storage) return "sidebar";
  try {
    return normalizeFarmingControlChatPlacement(
      storage.getItem(FARMING_CONTROL_CHAT_PLACEMENT_STORAGE_KEY),
    );
  } catch {
    return "sidebar";
  }
}

export function persistFarmingControlChatPlacement(
  placement: FarmingControlChatPlacement,
  storage: Pick<Storage, "setItem"> | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      FARMING_CONTROL_CHAT_PLACEMENT_STORAGE_KEY,
      normalizeFarmingControlChatPlacement(placement),
    );
  } catch {
    // Keep the in-memory preference when local storage is unavailable or blocked.
  }
}

export function getFarmingControlChatPlacement(): FarmingControlChatPlacement {
  return memoryPreference ?? readFarmingControlChatPlacement();
}

export function setFarmingControlChatPlacement(
  placement: FarmingControlChatPlacement,
): FarmingControlChatPlacement {
  memoryPreference = normalizeFarmingControlChatPlacement(placement);
  persistFarmingControlChatPlacement(memoryPreference);
  for (const listener of listeners) listener();
  return memoryPreference;
}

export function subscribeFarmingControlChatPlacement(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
