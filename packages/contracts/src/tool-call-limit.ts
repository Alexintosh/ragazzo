import * as z from "zod";

/** Suggested value when the operator enables a custom limit; the default is unlimited. */
export const DEFAULT_ENABLED_TOOL_CALL_LIMIT = 50;
export const ToolCallLimitSchema = z.number().int().min(1).max(2_147_483_647);
