-- deferred
-- The previous local release still reads these while deployments overlap.
ALTER TABLE "bots" DROP COLUMN "title";
ALTER TABLE "bots" DROP COLUMN "selfUpdateInstructions";

ALTER TABLE "referrals" DROP COLUMN "rewardKind";
ALTER TABLE "referrals" DROP COLUMN "declinedAt";
