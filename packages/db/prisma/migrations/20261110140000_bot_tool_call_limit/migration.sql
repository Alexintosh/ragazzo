-- Optional Pi tool-call override. Existing bots keep the deployment default.
ALTER TABLE "bots" ADD COLUMN "maxToolCallsPerTurn" INTEGER;
ALTER TABLE "bots" ADD CONSTRAINT "bots_max_tool_calls_positive"
  CHECK ("maxToolCallsPerTurn" IS NULL OR "maxToolCallsPerTurn" >= 1);
