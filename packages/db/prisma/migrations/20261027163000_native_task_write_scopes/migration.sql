ALTER TABLE "tasks" ADD COLUMN "writeSubdirectory" TEXT;
CREATE TABLE "native_execution_reservations" (
  "runId" TEXT PRIMARY KEY,
  "hostKey" TEXT NOT NULL,
  "writeRoot" TEXT,
  "ownerFence" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "native_execution_reservations_hostKey_expiresAt_idx"
ON "native_execution_reservations" ("hostKey", "expiresAt");
ALTER TABLE "native_execution_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "native_execution_reservations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "native_execution_reservations_system" ON "native_execution_reservations"
USING (current_setting('app.rls_bypass', true) = 'on')
WITH CHECK (current_setting('app.rls_bypass', true) = 'on');
