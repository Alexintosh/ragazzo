import { describe, expect, it } from "vitest";
import {
  createConversationEngines,
  describeConversationEngines,
  parseConversationEngines,
} from "./conversation-engines.js";

const valid = {
  id: "eros",
  baseUrl: "http://eros:8080",
  jwtSecret: "synthetic-server-signing-secret-value",
  callerSecret: "synthetic-server-caller-secret-value",
  characters: [{ id: "22222222-2222-4222-8222-222222222222", name: "Character" }],
};

describe("optional deployment conversation engines", () => {
  it("keeps Eros absent unless configured", () => {
    expect(parseConversationEngines()).toEqual([]);
    expect(createConversationEngines({}).size).toBe(0);
  });

  it("projects only browser-safe descriptors", () => {
    const engines = createConversationEngines({ CONVERSATION_ENGINES: JSON.stringify([valid]) });
    expect(describeConversationEngines(engines)).toEqual([
      {
        id: "eros",
        name: "Eros",
        characters: valid.characters,
        capabilities: { streaming: true, tools: false, cancel: false },
      },
    ]);
    expect(JSON.stringify(describeConversationEngines(engines))).not.toContain(valid.jwtSecret);
    expect(JSON.stringify(describeConversationEngines(engines))).not.toContain(valid.callerSecret);
    expect(JSON.stringify(describeConversationEngines(engines))).not.toContain(valid.baseUrl);
    expect(JSON.stringify([...engines.values()])).not.toContain(valid.jwtSecret);
  });

  it.each([
    "malformed JSON",
    JSON.stringify({ eros: valid }),
    JSON.stringify([{ ...valid, id: "unknown" }]),
    JSON.stringify([{ ...valid, jwtSecret: "short" }]),
    JSON.stringify([{ ...valid, callerSecret: "short" }]),
    JSON.stringify([{ ...valid, characters: [] }]),
    JSON.stringify([{ ...valid, characters: [{ id: "not-a-uuid", name: "Character" }] }]),
    JSON.stringify([{ ...valid, arbitrary: true }]),
    JSON.stringify([{ ...valid, characters: [...valid.characters, ...valid.characters] }]),
    JSON.stringify([valid, valid]),
    JSON.stringify([{ ...valid, baseUrl: "http://public.example" }]),
  ])("fails closed on invalid configuration without echoing secrets", (raw) => {
    expect(() => parseConversationEngines(raw)).toThrow(
      "Invalid CONVERSATION_ENGINES configuration",
    );
  });
});
