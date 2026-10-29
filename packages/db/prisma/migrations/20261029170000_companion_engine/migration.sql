ALTER TABLE "bots" ADD COLUMN "conversationEngine" TEXT NOT NULL DEFAULT 'internal', ADD COLUMN "erosCharacterId" TEXT;
-- Widen the existing invariant while preserving every internal-story constraint.
ALTER TABLE "bots" DROP CONSTRAINT "bots_roleplay_execution_check";
ALTER TABLE "bots" ADD CONSTRAINT "bots_roleplay_execution_check" CHECK (
  "botKind" IN ('agent', 'roleplay') AND "conversationEngine" IN ('internal', 'eros') AND
  (("botKind" = 'agent' AND "roleplayCharacter" IS NULL AND "conversationEngine" = 'internal' AND "erosCharacterId" IS NULL) OR
   ("botKind" = 'roleplay' AND
    (("conversationEngine" = 'internal' AND "roleplayCharacter" IS NOT NULL AND "erosCharacterId" IS NULL) OR
     ("conversationEngine" = 'eros' AND "roleplayCharacter" IS NULL AND "erosCharacterId" IS NOT NULL AND "computerId" IS NULL)) AND
    "runtimeKind" = 'pi' AND "executionTarget" = 'docker' AND
    "runtimePermission" = 'workspace' AND "registeredHostId" IS NULL AND "projectPath" IS NULL AND
    "fleetManagement" = false AND "crossSpaceCommunication" = false AND "teamChatAmbientEnabled" = false))
);
CREATE FUNCTION prevent_conversation_engine_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."conversationEngine" IS DISTINCT FROM OLD."conversationEngine" OR NEW."erosCharacterId" IS DISTINCT FROM OLD."erosCharacterId" THEN
    RAISE EXCEPTION 'Conversation engine and external character cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bots_immutable_conversation_engine BEFORE UPDATE OF "conversationEngine", "erosCharacterId" ON "bots"
FOR EACH ROW EXECUTE FUNCTION prevent_conversation_engine_change();

CREATE TABLE "companion_sessions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "threadId" TEXT NOT NULL REFERENCES "threads"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "historyGeneration" INTEGER NOT NULL,
  "engineUserId" TEXT NOT NULL,
  "engineSessionId" TEXT,
  "engineInstanceId" TEXT,
  "leaseRunId" TEXT,
  "leaseFence" INTEGER,
  "leaseExpiresAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "companion_sessions_threadId_historyGeneration_key" ON "companion_sessions"("threadId", "historyGeneration");
CREATE UNIQUE INDEX "companion_sessions_engineUserId_key" ON "companion_sessions"("engineUserId");
CREATE UNIQUE INDEX "companion_sessions_engineSessionId_key" ON "companion_sessions"("engineSessionId");
CREATE INDEX "companion_sessions_spaceId_userId_idx" ON "companion_sessions"("spaceId", "userId");

CREATE TABLE "companion_turns" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL REFERENCES "runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sessionId" TEXT NOT NULL REFERENCES "companion_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clientMessageId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'prepared',
  "engineUserMessageId" TEXT,
  "input" TEXT NOT NULL,
  "response" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "companion_turns_runId_key" ON "companion_turns"("runId");
CREATE UNIQUE INDEX "companion_turns_clientMessageId_key" ON "companion_turns"("clientMessageId");
CREATE INDEX "companion_turns_sessionId_status_idx" ON "companion_turns"("sessionId", "status");
CREATE INDEX "companion_turns_spaceId_userId_idx" ON "companion_turns"("spaceId", "userId");
-- External state must be explicitly removed before its local ownership mapping can be deleted.
ALTER TABLE "companion_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY companion_sessions_tenant ON "companion_sessions"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY companion_sessions_system ON "companion_sessions" USING (current_setting('app.rls_bypass', true) = 'on');
ALTER TABLE "companion_turns" ENABLE ROW LEVEL SECURITY;
CREATE POLICY companion_turns_tenant ON "companion_turns"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY companion_turns_system ON "companion_turns" USING (current_setting('app.rls_bypass', true) = 'on');
