import { describe, expect, it } from "vitest";
import { resolveCodexExecutable } from "./codex-executable.js";

describe("native Codex CLI discovery", () => {
  it("finds a user CLI from a minimal GUI PATH and supplies coding tools a usable PATH", () => {
    const result = resolveCodexExecutable({
      env: {
        PATH: "/usr/bin:/bin",
        RAKAZO_HOST_COMPUTER_TOKEN: "fake-host-secret",
        HOME: "/fake-home",
      },
      home: "/fake-home",
      execPath: "/opt/node/bin/node",
      canExecute: (candidate) => candidate === "/fake-home/.local/bin/codex",
    });
    expect(result.executable).toBe("/fake-home/.local/bin/codex");
    expect(result.env.PATH).toContain("/opt/homebrew/bin");
    expect(result.env.PATH).toContain("/opt/node/bin");
    expect(result.env).not.toHaveProperty("RAKAZO_HOST_COMPUTER_TOKEN");
  });
  it("ignores relative PATH entries and never invokes a login shell", () => {
    const candidates: string[] = [];
    expect(() =>
      resolveCodexExecutable({
        env: { PATH: ".:relative/bin:/usr/bin" },
        home: "/fake-home",
        execPath: "/opt/node/bin/node",
        canExecute(candidate) {
          candidates.push(candidate);
          return false;
        },
      }),
    ).toThrow("CLI is unavailable");
    expect(candidates.every((candidate) => candidate.startsWith("/"))).toBe(true);
    expect(candidates).not.toContain("relative/bin/codex");
  });
});
