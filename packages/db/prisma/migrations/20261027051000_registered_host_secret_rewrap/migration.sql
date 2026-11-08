-- Secret-store migration changes only the encrypted envelope/reference under an audited
-- system context. User APIs cannot replace credentials or change host identity.
CREATE OR REPLACE FUNCTION registered_host_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW."id", NEW."spaceId", NEW."userId", NEW."endpoint") IS DISTINCT FROM ROW(OLD."id", OLD."spaceId", OLD."userId", OLD."endpoint")
 OR (NEW."ciphertext" IS DISTINCT FROM OLD."ciphertext" AND current_setting('app.rls_bypass', true) IS DISTINCT FROM 'on')
 OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
  RAISE EXCEPTION 'Registered host identity is immutable; register a replacement host';
 END IF;
 RETURN NEW;
END $$;
