ALTER TABLE "bots"
  ADD COLUMN "conversationEngineSettings" JSONB,
  ADD COLUMN "conversationEngineSettingsRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "companion_turns" ADD COLUMN "request" JSONB;
