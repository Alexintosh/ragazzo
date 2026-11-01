ALTER TABLE "user" ADD COLUMN "roleplayEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Preserve access for accounts that already created roleplay characters.
UPDATE "user" SET "roleplayEnabled" = true
WHERE EXISTS (
  SELECT 1 FROM "bots"
  WHERE "bots"."userId" = "user"."id" AND "bots"."botKind" = 'roleplay'
);
