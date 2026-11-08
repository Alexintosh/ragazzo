import { SandboxUnavailableError } from "@rakazo/adapter-kit";

export const HOST_COMPUTER_STOPPED_MESSAGE = "Local computer stopped";

/** The connection failed before the host could accept the request. */
export class HostComputerUnavailableError extends SandboxUnavailableError {
  constructor(options?: { cause?: unknown }) {
    super(options);
    this.name = "HostComputerUnavailableError";
    this.message =
      "Host computer unavailable. Check the host connection and enable host access locally.";
  }
}

/** Only connection establishment failures prove that host work never started. */
export function isHostConnectionUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof AggregateError)
    return error.errors.length > 0 && error.errors.every(isHostConnectionUnavailable);
  if ("code" in error && typeof error.code === "string")
    return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"].includes(
      error.code,
    );
  return error.cause !== undefined && isHostConnectionUnavailable(error.cause);
}

export const NATIVE_CODEX_CLEANUP_FAILED_MESSAGE =
  "Native Codex cleanup failed; turn outcome is uncertain. Check the project before starting a new run";

export function isNativeCodexCleanupFailedError(error: unknown): error is Error {
  return error instanceof Error && error.message === NATIVE_CODEX_CLEANUP_FAILED_MESSAGE;
}

// Only exact, reviewed static messages may cross the host boundary. Never pass through
// provider errors, process stderr, prompts, credentials, or filesystem paths.
const safeNativeMessages = new Set([
  HOST_COMPUTER_STOPPED_MESSAGE,
  "Native Codex turn outcome is uncertain. Check the project before starting a new run.",
  "Native Codex output limit exceeded",
  "Native Codex supervision expired",
  "Native Codex request binding mismatch",
  "Native Codex requested an unsupported interaction",
  "Native Codex supports one question at a time",
  "Native Codex secret input requires local sign-in",
  "Concurrent native approvals are unsupported",
  "Native Codex approval scope is unavailable",
  "Native Codex turn failed or was interrupted",
  "Sign in to Codex on the host before starting this bot",
  "Native Codex account changed; start a new conversation",
  "Native session does not belong to this bot and project",
  "Native Codex returned no session",
  "Native Codex requires a canonical absolute project directory",
  "Native Codex project must be a directory",
  "Native Codex process supervision is unsupported on this host",
  "Native run binding mismatch",
  "Native Codex supervision capacity reached",
  "Native conversation is already running",
  "Native approval is no longer available",
  "Native approval already answered",
  "Native approval binding mismatch",
  "Choose approve or reject",
  "Native Codex stopped",
  "Local computer access revoked",
  "Native Codex disconnected",
  "Native Codex CLI is unavailable",
  "Native Codex request failed",
  "Sign in to the native runtime on the host before starting this bot",
  "ACP is not configured on this host",
  "ACP agent does not support session resume",
  "ACP agent does not support HTTP MCP application tools",
  "ACP agent does not support this input capability",
  "ACP does not guarantee workspace confinement; choose Full access explicitly",
  "Claude Code workspace confinement cannot be verified; choose Full access explicitly",
  "Native process cleanup is uncertain",
  NATIVE_CODEX_CLEANUP_FAILED_MESSAGE,
  "Native Codex configuration is unavailable",
  "Native Codex MCP configuration is invalid",
  "Scoped tasks require Codex Workspace without application tools",
  "Native work requires a canonical existing project directory",
  "Choose an existing project subdirectory",
  "Task write scope must be a canonical existing project subdirectory",
  "Task write scope contains a hardlinked file",
  "Task write scope is too large to verify safely",
  "Native task stopped while waiting for its write scope",
  "Native task write scope is required",
  "Native write coordinator requires a canonical private directory",
  "Task write scope overlaps private native state",
  "Native Codex response uncertain; do not retry the turn",
]);

export function hostComputerErrorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    (safeNativeMessages.has(error.message) ||
      error.message === "Path escapes the computer workspace" ||
      /^computer file exceeds \d+ bytes$/.test(error.message))
  )
    return error.message;
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
    return "computer file not found";
  return "Local computer operation failed";
}
