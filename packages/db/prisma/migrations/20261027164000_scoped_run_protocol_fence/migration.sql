-- Previous workers do not understand task write scopes. Keep their existing
-- access to ordinary runs, but never let them claim or recreate a scoped run.
CREATE POLICY runs_scoped_protocol ON "runs" AS RESTRICTIVE
USING (
  app_rls_version() >= 3 OR NOT EXISTS (
    SELECT 1 FROM "tasks" AS scope_task
    WHERE scope_task."threadId" = "runs"."threadId"
      AND scope_task.conversation = true
      AND scope_task."writeSubdirectory" IS NOT NULL
  )
)
WITH CHECK (
  app_rls_version() >= 3 OR NOT EXISTS (
    SELECT 1 FROM "tasks" AS scope_task
    WHERE scope_task."threadId" = "runs"."threadId"
      AND scope_task.conversation = true
      AND scope_task."writeSubdirectory" IS NOT NULL
  )
);
