ALTER TYPE "CampaignStatus" ADD VALUE 'CANCELLED';
ALTER TABLE "Campaign" ADD COLUMN "autoSchedule" BOOLEAN NOT NULL DEFAULT true;
-- campaigns made before this keep their manual approval
UPDATE "Campaign" SET "autoSchedule" = false;
ALTER TABLE "Email" ADD COLUMN "step" TEXT;
CREATE TYPE "ProfileStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'FAILED');
CREATE TABLE "StudentProfile" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "text" TEXT NOT NULL,
    "parts" JSONB NOT NULL DEFAULT '[]',
    "brief" TEXT,
    "status" "ProfileStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMPTZ(3),
    "notBefore" TIMESTAMPTZ(3),
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StudentProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StudentProfile_studentId_version_key" ON "StudentProfile"("studentId", "version");
ALTER TABLE "StudentProfile" ADD CONSTRAINT "StudentProfile_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
