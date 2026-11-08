ALTER TABLE "threads" ADD COLUMN "taskBotId" TEXT;
ALTER TABLE "threads" ADD CONSTRAINT "threads_taskBotId_fkey" FOREIGN KEY ("taskBotId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "threads_taskBotId_idx" ON "threads"("taskBotId");
-- Preserve exactly one owner while adding dedicated task conversations.
ALTER TABLE "threads" DROP CONSTRAINT "threads_owner_chk";
ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_chk" CHECK (
  num_nonnulls("botId", "groupId", "externalConversationId", "taskBotId") = 1
);
