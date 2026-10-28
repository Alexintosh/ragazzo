import { describe, expect, it } from "vitest";
import {
  HOST_COMPUTER_STOPPED_MESSAGE,
  hostComputerErrorMessage,
  isHostConnectionUnavailable,
  isNativeCodexCleanupFailedError,
  NATIVE_CODEX_CLEANUP_FAILED_MESSAGE,
} from "./host-computer-errors.js";

describe("host computer error boundary", () => {
  it.each([
    HOST_COMPUTER_STOPPED_MESSAGE,
    "Native Codex turn outcome is uncertain. Check the project before starting a new run.",
    "Native Codex response uncertain; do not retry the turn",
    "Sign in to Codex on the host before starting this bot",
    "Native Codex account changed; start a new conversation",
    "Native Codex requires a canonical absolute project directory",
    "Native Codex project must be a directory",
    "Native Codex disconnected",
    "Native Codex CLI is unavailable",
    "Native Codex request failed",
    "Native Codex cleanup failed; turn outcome is uncertain. Check the project before starting a new run",
    "Native Codex configuration is unavailable",
    "Native Codex MCP configuration is invalid",
    "Native approval is no longer available",
  ])("preserves the actionable static error: %s", (message) => {
    expect(hostComputerErrorMessage(new Error(message))).toBe(message);
  });

  it.each([
    new Error("provider rejected prompt: private task; credential: fake-secret"),
    new Error("EACCES: permission denied, open '/private/example/project'"),
    new Error("Native Codex request failed: fake-secret"),
    new Error("Native Codex disconnected\n/private/example/project"),
    new Error("Native Codex turn outcome is uncertain. private task"),
    new Error(`${HOST_COMPUTER_STOPPED_MESSAGE}: private detail`),
    { message: "Native Codex disconnected", credential: "fake-secret" },
    "Native Codex disconnected",
    undefined,
  ])("redacts arbitrary errors and near matches (%#)", (error) => {
    expect(hostComputerErrorMessage(error)).toBe("Local computer operation failed");
  });

  it("keeps existing file errors free of paths", () => {
    expect(
      hostComputerErrorMessage(
        Object.assign(new Error("ENOENT: '/private/example/project'"), { code: "ENOENT" }),
      ),
    ).toBe("computer file not found");
    expect(hostComputerErrorMessage(new Error("Path escapes the computer workspace"))).toBe(
      "Path escapes the computer workspace",
    );
    expect(hostComputerErrorMessage(new Error("computer file exceeds 100 bytes"))).toBe(
      "computer file exceeds 100 bytes",
    );
  });
});

describe("host connection failure classification", () => {
  it("requires every attempted address to fail before accepting a connection", () => {
    const refused = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const reset = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    expect(isHostConnectionUnavailable(new AggregateError([refused, refused]))).toBe(true);
    expect(isHostConnectionUnavailable(new AggregateError([refused, reset]))).toBe(false);
    expect(
      isHostConnectionUnavailable(
        Object.assign(new AggregateError([refused, refused]), { code: "ECONNREFUSED" }),
      ),
    ).toBe(true);
    expect(
      isHostConnectionUnavailable(
        Object.assign(new AggregateError([refused, reset]), { code: "ECONNREFUSED" }),
      ),
    ).toBe(false);
    expect(isHostConnectionUnavailable(new AggregateError([]))).toBe(false);
  });

  it("does not let a nested refusal override an uncertain outer failure", () => {
    const refused = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    expect(
      isHostConnectionUnavailable(
        Object.assign(new Error("connection reset", { cause: refused }), { code: "ECONNRESET" }),
      ),
    ).toBe(false);
  });
});

describe("native Codex cleanup failure", () => {
  it("recognizes only the exact reviewed Error message", () => {
    expect(isNativeCodexCleanupFailedError(new Error(NATIVE_CODEX_CLEANUP_FAILED_MESSAGE))).toBe(
      true,
    );
    for (const error of [
      new Error(`${NATIVE_CODEX_CLEANUP_FAILED_MESSAGE}: private detail`),
      new Error("unrelated failure"),
      { message: NATIVE_CODEX_CLEANUP_FAILED_MESSAGE },
      NATIVE_CODEX_CLEANUP_FAILED_MESSAGE,
    ]) {
      expect(isNativeCodexCleanupFailedError(error)).toBe(false);
      expect(hostComputerErrorMessage(error)).toBe("Local computer operation failed");
    }
  });
});
