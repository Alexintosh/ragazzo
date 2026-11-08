-- Deliberately independent of membership: leaving a Space does not stop local setup.
CREATE TABLE "native_setup_owners" (
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("spaceId", "userId")
);
CREATE INDEX "native_setup_owners_userId_idx" ON "native_setup_owners"("userId");
ALTER TABLE "native_setup_owners" ENABLE ROW LEVEL SECURITY;
CREATE POLICY native_setup_owners_system ON "native_setup_owners" USING (current_setting('app.rls_bypass', true) = 'on');
CREATE POLICY native_setup_owners_tenant ON "native_setup_owners" USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
