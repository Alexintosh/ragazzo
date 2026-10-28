-- Additive for rolling deploys: old membership writers must honor decisions made
-- by a new deleter, even though they do not know about this column.
BEGIN;

ALTER TABLE "spaces" ADD COLUMN "deletionCleanupStartedAt" TIMESTAMP(3);
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_cleanup_requires_claim"
  CHECK ("deletionCleanupStartedAt" IS NULL OR
    ("deletingAt" IS NOT NULL AND "deletionClaimId" IS NOT NULL));

CREATE FUNCTION prevent_space_cleanup_reversal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."deletionCleanupStartedAt" IS NOT NULL AND
    (NEW."deletionCleanupStartedAt" IS DISTINCT FROM OLD."deletionCleanupStartedAt" OR
     NEW."deletionClaimId" IS DISTINCT FROM OLD."deletionClaimId") THEN
    RAISE EXCEPTION 'Space cleanup decision cannot be reversed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_preserve_cleanup_decision
  BEFORE UPDATE ON "spaces" FOR EACH ROW EXECUTE FUNCTION prevent_space_cleanup_reversal();

CREATE FUNCTION prevent_membership_after_space_cleanup() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cleanup_started TIMESTAMP(3);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."spaceId" IS NOT DISTINCT FROM OLD."spaceId" AND
       NEW."organizationId" IS NOT DISTINCT FROM OLD."organizationId" AND
       NEW."userId" IS NOT DISTINCT FROM OLD."userId" THEN
      RETURN NEW;
    END IF;
  END IF;

  -- SHARE conflicts with the final decision's UPDATE, unlike the FK's KEY SHARE.
  -- Hold it to commit: the deleter either sees this membership or admission sees
  -- the committed cleanup marker. Snapshot isolation retries conflicting writes.
  SELECT "deletionCleanupStartedAt" INTO cleanup_started
    FROM "spaces" WHERE "id" = NEW."spaceId" FOR SHARE;
  IF cleanup_started IS NOT NULL THEN
    RAISE EXCEPTION 'Space deletion cleanup has started' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER space_members_reject_cleanup_admission
  BEFORE INSERT OR UPDATE OF "spaceId", "organizationId", "userId" ON "space_members"
  FOR EACH ROW EXECUTE FUNCTION prevent_membership_after_space_cleanup();

COMMIT;
