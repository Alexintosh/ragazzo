import { useState } from "react";

const storageKey = "rakazo.farmingControl.portfolioDemoSeed";

export function usePortfolioDemo() {
  const [seed, setSeed] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(storageKey) || null;
    } catch {
      return null;
    }
  });

  function toggle() {
    const next = seed === null ? crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36) : null;
    try {
      if (next === null) sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, next);
    } catch {
      // The toggle still works in memory when tab storage is unavailable.
    }
    setSeed(next);
  }

  return { seed, toggle };
}
