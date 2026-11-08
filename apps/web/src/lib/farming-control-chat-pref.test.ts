import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FARMING_CONTROL_CHAT_PLACEMENT_STORAGE_KEY,
  getFarmingControlChatPlacement,
  normalizeFarmingControlChatPlacement,
  persistFarmingControlChatPlacement,
  readFarmingControlChatPlacement,
  setFarmingControlChatPlacement,
  subscribeFarmingControlChatPlacement,
} from "./farming-control-chat-pref";

beforeEach(() => {
  vi.stubGlobal("localStorage", undefined);
  setFarmingControlChatPlacement("sidebar");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Farming Control chat placement", () => {
  it("defaults to the right sidebar and restores a saved main view choice", () => {
    expect(normalizeFarmingControlChatPlacement(null)).toBe("sidebar");
    expect(normalizeFarmingControlChatPlacement("unknown")).toBe("sidebar");
    expect(normalizeFarmingControlChatPlacement(" MAIN ")).toBe("main");
    expect(readFarmingControlChatPlacement()).toBe("sidebar");
    expect(readFarmingControlChatPlacement({ getItem: () => "main" })).toBe("main");
  });

  it("persists the choice and updates mounted consumers", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    const listener = vi.fn();
    const unsubscribe = subscribeFarmingControlChatPlacement(listener);

    expect(setFarmingControlChatPlacement("main")).toBe("main");
    expect(getFarmingControlChatPlacement()).toBe("main");
    expect(store.get(FARMING_CONTROL_CHAT_PLACEMENT_STORAGE_KEY)).toBe("main");
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    setFarmingControlChatPlacement("sidebar");
    expect(store.get(FARMING_CONTROL_CHAT_PLACEMENT_STORAGE_KEY)).toBe("sidebar");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("keeps the session choice when storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readFarmingControlChatPlacement(blocked)).toBe("sidebar");
    expect(() => persistFarmingControlChatPlacement("main", blocked)).not.toThrow();
    vi.stubGlobal("localStorage", blocked);
    expect(() => setFarmingControlChatPlacement("main")).not.toThrow();
    expect(getFarmingControlChatPlacement()).toBe("main");
  });
});
