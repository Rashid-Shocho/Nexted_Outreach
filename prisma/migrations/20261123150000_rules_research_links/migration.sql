ALTER TABLE "Student" ADD COLUMN "phone" TEXT;
ALTER TABLE "Professor" ADD COLUMN "papers" JSONB, ADD COLUMN "papersAt" TIMESTAMPTZ(3);
ALTER TABLE "Email" ADD COLUMN "sendNow" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OAuthState" ALTER COLUMN "staffId" DROP NOT NULL, ADD COLUMN "nonceHash" TEXT, ADD COLUMN "linkId" TEXT;
CREATE TABLE "ConnectLink" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConnectLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConnectLink_tokenHash_key" ON "ConnectLink"("tokenHash");
