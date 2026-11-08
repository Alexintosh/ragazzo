import { describe, expect, it } from "vitest";
import {
  buildNativeHistory,
  NATIVE_HISTORY_MAX_BYTES,
  nativeContextScope,
} from "./native-context.js";

describe("native context handover", () => {
  it("binds transcript access to the tenant and owner without exposing channel identifiers", () => {
    const run = { id: "run-a", spaceId: "space-a", userId: "owner-a", trigger: "messaging" };
    const scope = nativeContextScope(run, "private-channel");
    expect(scope).toMatch(/^[a-f0-9]{64}$/);
    expect(nativeContextScope({ ...run, spaceId: "space-b" }, "private-channel")).not.toBe(scope);
    expect(nativeContextScope({ ...run, userId: "owner-b" }, "private-channel")).not.toBe(scope);
    expect(nativeContextScope({ ...run, id: "retry-run" }, "private-channel")).toBe(scope);
    expect(nativeContextScope(run)).not.toBe(scope);
  });
  it("preserves chronology and excludes steering already sent as current input", () => {
    expect(
      buildNativeHistory(
        [
          { id: "a", role: "user", content: "Original task" },
          { id: "b", role: "assistant", content: "Previous result" },
          { id: "c", role: "user", content: "Current steering" },
        ],
        { excludeMessageIds: new Set(["c"]) },
      ),
    ).toBe("user: Original task\n\nassistant: Previous result");
  });

  it("keeps recent work and labels truncation without exceeding the byte budget", () => {
    const result = buildNativeHistory(
      [
        { role: "user", content: "Old instruction ".repeat(100) },
        { role: "assistant", content: "Recent result" },
        { role: "user", content: "Next step" },
      ],
      { maxBytes: 200 },
    );
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(200);
    expect(result).toContain("Earlier conversation context omitted");
    expect(result).toContain("user (end of message):");
    expect(result.endsWith("assistant: Recent result\n\nuser: Next step")).toBe(true);
  });

  it("retains a valid Unicode suffix of a single oversized message", () => {
    const result = buildNativeHistory(
      [{ role: "assistant", content: `${"😀界".repeat(100_000)}Final result` }],
      { maxBytes: 199 },
    );
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(199);
    expect(result).not.toContain("\uFFFD");
    expect(result.endsWith("Final result")).toBe(true);
  });

  it("bounds the default handover and leaves empty context empty", () => {
    expect(buildNativeHistory([])).toBe("");
    expect(
      Buffer.byteLength(
        buildNativeHistory([{ role: "user", content: "x".repeat(2 * NATIVE_HISTORY_MAX_BYTES) }]),
      ),
    ).toBeLessThanOrEqual(NATIVE_HISTORY_MAX_BYTES);
  });

  it.each([0, 127, 1.5, NaN, NATIVE_HISTORY_MAX_BYTES + 1])(
    "rejects invalid budget %s",
    (maxBytes) => {
      expect(() => buildNativeHistory([], { maxBytes })).toThrow("Invalid native history budget");
    },
  );
});
