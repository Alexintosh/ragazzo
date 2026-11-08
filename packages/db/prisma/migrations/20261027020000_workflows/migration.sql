-- Additive tables; existing turn/task and runtime execution contracts are unchanged.
CREATE TABLE "workflows" (
  "id" TEXT PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "graph" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "workflows_spaceId_userId_updatedAt_idx" ON "workflows"("spaceId", "userId", "updatedAt");
CREATE TABLE "workflow_runs" (
  "id" TEXT PRIMARY KEY,
  "workflowId" TEXT NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "cancelPending" BOOLEAN NOT NULL DEFAULT false,
  "definitionRevision" INTEGER NOT NULL,
  "graph" JSONB NOT NULL,
  "nodes" JSONB NOT NULL,
  "status" TEXT NOT NULL,
  "clientNonce" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "workflow_runs_spaceId_userId_clientNonce_key" ON "workflow_runs"("spaceId", "userId", "clientNonce");
CREATE INDEX "workflow_runs_status_updatedAt_id_idx" ON "workflow_runs"("status", "updatedAt", "id");
CREATE INDEX "workflow_runs_workflowId_createdAt_idx" ON "workflow_runs"("workflowId", "createdAt");
DO $$ DECLARE protected text; BEGIN
  FOREACH protected IN ARRAY ARRAY['workflows', 'workflow_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', protected);
    EXECUTE format('CREATE POLICY %I ON %I USING (current_setting(''app.rls_bypass'', true) = ''on'')', protected || '_system', protected);
    EXECUTE format('CREATE POLICY %I ON %I USING ("spaceId" = NULLIF(current_setting(''app.space_id'', true), '''') AND "userId" = NULLIF(current_setting(''app.user_id'', true), ''''))', protected || '_tenant', protected);
  END LOOP;
END $$;
