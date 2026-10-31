import { describe, expect, it } from "vitest";
import {
  MAX_MODEL_TIMEOUT_MS,
  ModelConnectInputSchema,
  ModelCredentialSchema,
  parseModelTimeoutMs,
} from "./domain.js";

describe("model request timeout settings", () => {
  it.each([1, 900_000, MAX_MODEL_TIMEOUT_MS])(
    "accepts bounded integer milliseconds %s",
    (value) => {
      expect(parseModelTimeoutMs(value)).toBe(value);
      expect(parseModelTimeoutMs(` ${value} `)).toBe(value);
    },
  );

  it.each([0, -1, 1.5, MAX_MODEL_TIMEOUT_MS + 1, Infinity, NaN, "", "1e3", "1ms", null, true])(
    "rejects invalid milliseconds %s",
    (value) => expect(parseModelTimeoutMs(value)).toBeUndefined(),
  );

  it.each(["streamTimeoutMs", "streamIdleTimeoutMs"] as const)(
    "validates %s in connection inputs and credential DTOs",
    (field) => {
      const input = { provider: "anthropic", [field]: 900_000 };
      expect(ModelConnectInputSchema.parse(input)).toMatchObject(input);
      expect(ModelConnectInputSchema.safeParse({ ...input, [field]: null }).success).toBe(true);
      for (const invalid of [0, -1, 1.5, MAX_MODEL_TIMEOUT_MS + 1, "900000"]) {
        expect(ModelConnectInputSchema.safeParse({ ...input, [field]: invalid }).success).toBe(
          false,
        );
      }
      expect(
        ModelCredentialSchema.parse({
          id: "connection-fixture",
          provider: "anthropic",
          label: "Anthropic",
          hasKey: true,
          isDefault: false,
          [field]: 900_000,
        }),
      ).toMatchObject({ [field]: 900_000 });
    },
  );
});
