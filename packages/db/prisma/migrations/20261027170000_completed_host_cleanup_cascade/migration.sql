-- Completed teardown receipts must not prevent removal of their owning Space/account.
-- Pending work, including managed CLI setup without run receipts, keeps its identity durable.
ALTER TABLE "registered_host_cleanup" DROP CONSTRAINT "registered_host_cleanup_hostId_spaceId_userId_fkey";
ALTER TABLE "registered_host_cleanup" ADD CONSTRAINT "registered_host_cleanup_hostId_spaceId_userId_fkey"
 FOREIGN KEY ("hostId", "spaceId", "userId") REFERENCES "registered_hosts"("id", "spaceId", "userId") ON DELETE CASCADE;
CREATE FUNCTION registered_host_cleanup_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD."revocationPending" OR EXISTS (SELECT 1 FROM "registered_host_cleanup" WHERE "hostId" = OLD."id" AND "completedAt" IS NULL) THEN
  RAISE EXCEPTION 'Registered host cleanup is pending';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER registered_host_cleanup_before_delete BEFORE DELETE ON "registered_hosts"
 FOR EACH ROW EXECUTE FUNCTION registered_host_cleanup_before_delete();
