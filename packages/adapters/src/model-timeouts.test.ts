import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { ModelConnectInput } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  buildModelConnectPlaintext,
  buildModelOAuthPlaintext,
  modelCredentialDto,
} from "./model-connect.js";
import type { StoredModelSecret } from "./pi-oauth.js";
import { parseModelSecret, secretValuesToRedact, serializeModelSecret } from "./pi-oauth.js";

const timeouts = { streamTimeoutMs: 900_000, streamIdleTimeoutMs: 900_000 };
const oauth: OAuthCredential = {
  type: "oauth",
  access: "fake-access",
  refresh: "fake-refresh",
  expires: 1,
};
const fixtures: { name: string; secret: StoredModelSecret; input: ModelConnectInput }[] = [
  {
    name: "API key",
    secret: { kind: "api_key", key: "fake-api-key" },
    input: { provider: "anthropic", maxTokens: null },
  },
  {
    name: "OAuth",
    secret: { kind: "oauth", credential: oauth },
    input: { provider: "openai-codex", maxTokens: null },
  },
  {
    name: "retired OAuth",
    secret: { kind: "oauth", reconnectRequired: true },
    input: { provider: "openai-codex", maxTokens: null },
  },
  {
    name: "keyless compatible",
    secret: { kind: "openai_compatible", baseUrl: "https://example.invalid/v1" },
    input: {
      provider: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
      modelId: "local-model",
    },
  },
];

describe.each(fixtures)("$name connection timeouts", ({ secret, input }) => {
  it("round-trips encrypted settings and exposes only numeric settings in its DTO", () => {
    const plaintext = serializeModelSecret({ ...secret, ...timeouts });
    expect(parseModelSecret(plaintext)).toMatchObject(timeouts);
    const dto = modelCredentialDto(
      { id: "fixture", label: "Fixture", provider: input.provider },
      plaintext,
    );
    expect(dto).toMatchObject(timeouts);
    for (const value of secretValuesToRedact(parseModelSecret(plaintext))) {
      expect(JSON.stringify(dto)).not.toContain(value);
    }
  });

  it("preserves omitted settings for older clients and resets only explicitly cleared values", () => {
    const plaintext = serializeModelSecret({ ...secret, ...timeouts });
    const preserved = buildModelConnectPlaintext(input, plaintext);
    expect(parseModelSecret(preserved)).toMatchObject(timeouts);
    const cleared = parseModelSecret(
      buildModelConnectPlaintext({ ...input, streamTimeoutMs: null }, preserved),
    );
    expect(cleared.streamTimeoutMs).toBeUndefined();
    expect(cleared.streamIdleTimeoutMs).toBe(900_000);
    expect(
      parseModelSecret(
        buildModelConnectPlaintext({ ...input, streamTimeoutMs: 600_000 }, preserved),
      ),
    ).toMatchObject({ ...timeouts, streamTimeoutMs: 600_000 });
  });
});

it("keeps timeouts and output settings when an OAuth connection signs in again", () => {
  const previous = serializeModelSecret({
    kind: "oauth",
    reconnectRequired: true,
    maxTokens: 2048,
    ...timeouts,
  });
  expect(parseModelSecret(buildModelOAuthPlaintext(oauth, previous))).toEqual({
    kind: "oauth",
    credential: oauth,
    maxTokens: 2048,
    ...timeouts,
  });
});
