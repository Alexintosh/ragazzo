-- Additive: older turn tasks and the unique direct-bot thread remain unchanged.
ALTER TABLE "tasks" ADD COLUMN "conversation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "originThreadId" TEXT,
  ADD COLUMN "recoveryOfRunId" TEXT,
  ADD COLUMN "clientNonce" TEXT,
  ADD COLUMN "sourceQueuedInputId" TEXT;
CREATE UNIQUE INDEX "tasks_recoveryOfRunId_key" ON "tasks"("recoveryOfRunId");
CREATE UNIQUE INDEX "tasks_spaceId_clientNonce_key" ON "tasks"("spaceId", "clientNonce");
CREATE UNIQUE INDEX "tasks_sourceQueuedInputId_key" ON "tasks"("sourceQueuedInputId");
CREATE INDEX "tasks_originThreadId_idx" ON "tasks"("originThreadId");
