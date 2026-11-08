import { describe, expect, it } from "vitest";
import { parseRoleplayInteger } from "./roleplay-editor.js";

describe("roleplay numeric drafts", () => {
  it.each(["", " ", "-", "2.5", "1e3", "Infinity", "NaN", "9007199254740992"])(
    "keeps %j invalid",
    (value) => expect(parseRoleplayInteger(value)).toBeNaN(),
  );
  it.each([
    ["0", 0],
    ["-100", -100],
    [" 32 ", 32],
    ["+2", 2],
  ] as const)("reads integer %j", (value, expected) =>
    expect(parseRoleplayInteger(value)).toBe(expected),
  );
});
