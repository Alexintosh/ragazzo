ALTER TABLE "registered_hosts" ADD COLUMN "revocationPending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "registered_hosts" ADD COLUMN "revocationAttemptedAt" TIMESTAMP(3);
CREATE TABLE "registered_host_cleanup" (
  "id" TEXT PRIMARY KEY,
  "hostId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "computerId" TEXT NOT NULL,
  "computerKey" TEXT NOT NULL,
  "targetRunId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attemptedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  FOREIGN KEY ("hostId", "spaceId", "userId") REFERENCES "registered_hosts"("id", "spaceId", "userId") ON DELETE RESTRICT,
  UNIQUE ("hostId", "runId", "computerId")
);
CREATE INDEX "registered_host_cleanup_hostId_completedAt_idx" ON "registered_host_cleanup"("hostId", "completedAt");
ALTER TABLE "registered_host_cleanup" ENABLE ROW LEVEL SECURITY;
CREATE POLICY registered_host_cleanup_system ON "registered_host_cleanup" USING (current_setting('app.rls_bypass', true) = 'on');
CREATE POLICY registered_host_cleanup_tenant ON "registered_host_cleanup" USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
-- Existing revoked registrations may still have provider work alive.
UPDATE "registered_hosts" SET "revocationPending" = true WHERE "revokedAt" IS NOT NULL;
