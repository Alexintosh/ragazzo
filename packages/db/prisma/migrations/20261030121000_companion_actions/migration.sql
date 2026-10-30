CREATE TABLE "companion_actions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sessionId" TEXT NOT NULL REFERENCES "companion_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "historyGeneration" INTEGER NOT NULL,
  "request" JSONB NOT NULL,
  "response" JSONB,
  "status" TEXT NOT NULL DEFAULT 'submitted',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "companion_actions_sessionId_status_idx" ON "companion_actions"("sessionId", "status");
CREATE INDEX "companion_actions_spaceId_userId_idx" ON "companion_actions"("spaceId", "userId");

ALTER TABLE "companion_actions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY companion_actions_tenant ON "companion_actions"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY companion_actions_system ON "companion_actions"
  USING (current_setting('app.rls_bypass', true) = 'on');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "companion_actions" TO rakazo_app;
  END IF;
END $$;
