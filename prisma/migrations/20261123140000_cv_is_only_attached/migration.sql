-- The CV is only attached to drafts; nothing is read from it.
ALTER TABLE "Cv" DROP COLUMN "text", DROP COLUMN "profile", DROP COLUMN "status", DROP COLUMN "attempts", DROP COLUMN "claimedAt", DROP COLUMN "error";
DROP TYPE "ParseStatus";
