ALTER TABLE "bots" ADD COLUMN "botKind" TEXT NOT NULL DEFAULT 'agent', ADD COLUMN "roleplayCharacter" JSONB;
ALTER TABLE "threads" ADD COLUMN "roleplayState" JSONB;
ALTER TABLE "bots" ADD CONSTRAINT "bots_roleplay_execution_check" CHECK (
  "botKind" IN ('agent', 'roleplay') AND
  (("botKind" = 'agent' AND "roleplayCharacter" IS NULL) OR
   ("botKind" = 'roleplay' AND "roleplayCharacter" IS NOT NULL AND
    "runtimeKind" = 'pi' AND "executionTarget" = 'docker' AND
    "runtimePermission" = 'workspace' AND "registeredHostId" IS NULL AND "projectPath" IS NULL AND
    "fleetManagement" = false AND "crossSpaceCommunication" = false AND "teamChatAmbientEnabled" = false))
);
CREATE FUNCTION prevent_bot_kind_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."botKind" IS DISTINCT FROM OLD."botKind" THEN
    RAISE EXCEPTION 'Bot kind cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bots_immutable_kind BEFORE UPDATE OF "botKind" ON "bots"
FOR EACH ROW EXECUTE FUNCTION prevent_bot_kind_change();
