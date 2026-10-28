-- Additive: older API/worker releases keep using their existing defaults.
ALTER TABLE "bots"
  ADD COLUMN "runtimeKind" TEXT NOT NULL DEFAULT 'pi',
  ADD COLUMN "executionTarget" TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN "runtimePermission" TEXT NOT NULL DEFAULT 'workspace',
  ADD COLUMN "projectPath" TEXT;
ALTER TABLE "computers" ADD COLUMN "executionTarget" TEXT NOT NULL DEFAULT 'default';
