CREATE TABLE "registered_hosts" (
 "id" TEXT PRIMARY KEY,
 "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
 "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
 "name" TEXT NOT NULL,
 "endpoint" TEXT NOT NULL,
 "ciphertext" TEXT NOT NULL,
 "revokedAt" TIMESTAMP(3),
 "healthStatus" TEXT NOT NULL DEFAULT 'unchecked',
 "healthCheckedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("id", "spaceId", "userId")
);
CREATE INDEX "registered_hosts_spaceId_userId_createdAt_idx" ON "registered_hosts"("spaceId", "userId", "createdAt");
ALTER TABLE "bots" ADD COLUMN "registeredHostId" TEXT;
ALTER TABLE "computers" ADD COLUMN "registeredHostId" TEXT;
ALTER TABLE "runs" ADD COLUMN "nativeHostId" TEXT;
ALTER TABLE "bots" ADD CONSTRAINT "bots_registered_host_scope" FOREIGN KEY ("registeredHostId", "spaceId", "userId") REFERENCES "registered_hosts"("id", "spaceId", "userId");
ALTER TABLE "computers" ADD CONSTRAINT "computers_registered_host_scope" FOREIGN KEY ("registeredHostId", "spaceId", "userId") REFERENCES "registered_hosts"("id", "spaceId", "userId");
ALTER TABLE "runs" ADD CONSTRAINT "runs_registered_host_scope" FOREIGN KEY ("nativeHostId", "spaceId", "userId") REFERENCES "registered_hosts"("id", "spaceId", "userId");
ALTER TABLE "bots" ADD CONSTRAINT "bots_registered_host_target" CHECK ("registeredHostId" IS NULL OR "executionTarget" = 'host');
ALTER TABLE "computers" ADD CONSTRAINT "computers_registered_host_target" CHECK ("registeredHostId" IS NULL OR "executionTarget" = 'host');
ALTER TABLE "registered_hosts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY registered_hosts_system ON "registered_hosts" USING (current_setting('app.rls_bypass', true) = 'on');
CREATE POLICY registered_hosts_tenant ON "registered_hosts" USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE FUNCTION registered_host_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW."id", NEW."spaceId", NEW."userId", NEW."endpoint", NEW."ciphertext") IS DISTINCT FROM ROW(OLD."id", OLD."spaceId", OLD."userId", OLD."endpoint", OLD."ciphertext") OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
  RAISE EXCEPTION 'Registered host identity is immutable; register a replacement host';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER registered_host_identity_immutable BEFORE UPDATE ON "registered_hosts" FOR EACH ROW EXECUTE FUNCTION registered_host_identity_immutable();
