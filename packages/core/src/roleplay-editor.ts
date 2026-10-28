import type { RoleplayCharacter, RoleplayLorebookEntry } from "@rakazo/contracts";

/** Keep incomplete or invalid numeric drafts invalid instead of coercing them to zero. */
export function parseRoleplayInteger(value: string): number {
  if (!/^[+-]?\d+$/.test(value.trim())) return Number.NaN;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : Number.NaN;
}

export function createRoleplayLorebook(): NonNullable<RoleplayCharacter["lorebook"]> {
  return { name: "", description: "", scanDepth: 2, tokenBudget: 2048, entries: [] };
}

export function createRoleplayLorebookEntry(insertionOrder = 0): RoleplayLorebookEntry {
  return {
    keys: [],
    secondaryKeys: [],
    content: "",
    enabled: true,
    constant: false,
    selective: false,
    caseSensitive: false,
    insertionOrder,
    position: "before_char",
  };
}
