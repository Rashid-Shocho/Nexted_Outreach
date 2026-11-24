-- CreateEnum
CREATE TYPE "MailboxStatus" AS ENUM ('CONNECTED', 'RECONNECT');

-- CreateEnum
CREATE TYPE "ParseStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "ListStatus" AS ENUM ('PREVIEW', 'IMPORTED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('GENERATING', 'REVIEW', 'ACTIVE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'GENERATING', 'GEN_FAILED', 'DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'BOUNCED', 'UNCERTAIN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('PROFESSOR', 'AUTO_REPLY', 'BOUNCE', 'OTHER');

-- CreateTable
CREATE TABLE "Staff" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "notes" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "consentAt" TIMESTAMPTZ(3),
    "consentBy" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mailbox" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "encryptedAccessToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "status" "MailboxStatus" NOT NULL DEFAULT 'CONNECTED',
    "lastError" TEXT,
    "sendPausedUntil" TIMESTAMPTZ(3),
    "historyId" TEXT,
    "lastSyncAt" TIMESTAMPTZ(3),
    "nextSyncAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncClaimedAt" TIMESTAMPTZ(3),
    "connectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "stateHash" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("stateHash")
);

-- CreateTable
CREATE TABLE "Cv" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "text" TEXT,
    "profile" JSONB,
    "status" "ParseStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMPTZ(3),
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cv_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfessorList" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" "ListStatus" NOT NULL DEFAULT 'PREVIEW',
    "headers" JSONB NOT NULL,
    "rows" JSONB NOT NULL,
    "mapping" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfessorList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Professor" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "university" TEXT,
    "department" TEXT,
    "researchArea" TEXT,
    "country" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Professor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "cvId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'GENERATING',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "pauseReason" TEXT,
    "intake" TEXT,
    "instructions" TEXT,
    "startDate" TEXT NOT NULL,
    "windowStart" TEXT NOT NULL DEFAULT '19:30',
    "windowEnd" TEXT NOT NULL DEFAULT '20:30',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dhaka',
    "minPerDay" INTEGER NOT NULL DEFAULT 15,
    "maxPerDay" INTEGER NOT NULL DEFAULT 20,
    "weekdays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Email" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "professorId" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "status" "EmailStatus" NOT NULL DEFAULT 'PENDING',
    "fit" TEXT,
    "fitNote" TEXT,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMPTZ(3),
    "notBefore" TIMESTAMPTZ(3),
    "contentVersion" INTEGER NOT NULL DEFAULT 1,
    "scheduledFor" TIMESTAMPTZ(3),
    "gmailDraftId" TEXT,
    "gmailThreadId" TEXT,
    "gmailMessageId" TEXT,
    "draftVersion" INTEGER,
    "draftTo" TEXT,
    "draftedAt" TIMESTAMPTZ(3),
    "draftError" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "sentTo" TEXT,
    "sandboxed" BOOLEAN,
    "repliedAt" TIMESTAMPTZ(3),
    "bouncedAt" TIMESTAMPTZ(3),
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Email_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "gmailThreadId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "kind" "MessageKind" NOT NULL DEFAULT 'OTHER',
    "emailId" TEXT,
    "fromName" TEXT,
    "fromEmail" TEXT,
    "snippet" TEXT,
    "hasIncoming" BOOLEAN NOT NULL DEFAULT false,
    "unread" BOOLEAN NOT NULL DEFAULT false,
    "lastMessageAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "outgoing" BOOLEAN NOT NULL,
    "kind" "MessageKind" NOT NULL DEFAULT 'OTHER',
    "fromName" TEXT,
    "fromEmail" TEXT NOT NULL,
    "toText" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "messageIdHeader" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffReply" (
    "id" TEXT NOT NULL,
    "clientKey" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "staffEmail" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "gmailDraftId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENDING',
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiUsage" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FakeMail" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "mailbox" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "draftId" TEXT,
    "labels" TEXT[],
    "headers" JSONB NOT NULL,
    "body" TEXT NOT NULL,
    "files" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FakeMail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Staff_email_key" ON "Staff"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Student_email_key" ON "Student"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_studentId_key" ON "Mailbox"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_email_key" ON "Mailbox"("email");

-- CreateIndex
CREATE INDEX "Mailbox_status_nextSyncAt_idx" ON "Mailbox"("status", "nextSyncAt");

-- CreateIndex
CREATE UNIQUE INDEX "Cv_studentId_version_key" ON "Cv"("studentId", "version");

-- CreateIndex
CREATE INDEX "Professor_email_idx" ON "Professor"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Professor_listId_email_key" ON "Professor"("listId", "email");

-- CreateIndex
CREATE INDEX "Campaign_studentId_idx" ON "Campaign"("studentId");

-- CreateIndex
CREATE INDEX "Email_campaignId_status_idx" ON "Email"("campaignId", "status");

-- CreateIndex
CREATE INDEX "Email_status_scheduledFor_idx" ON "Email"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "Email_toEmail_idx" ON "Email"("toEmail");

-- CreateIndex
CREATE INDEX "Email_gmailThreadId_idx" ON "Email"("gmailThreadId");

-- CreateIndex
CREATE UNIQUE INDEX "Email_studentId_toEmail_key" ON "Email"("studentId", "toEmail");

-- CreateIndex
CREATE INDEX "Thread_hasIncoming_kind_lastMessageAt_idx" ON "Thread"("hasIncoming", "kind", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_studentId_gmailThreadId_key" ON "Thread"("studentId", "gmailThreadId");

-- CreateIndex
CREATE INDEX "Message_threadId_sentAt_idx" ON "Message"("threadId", "sentAt");

-- CreateIndex
CREATE INDEX "Message_studentId_fromEmail_idx" ON "Message"("studentId", "fromEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Message_studentId_gmailMessageId_key" ON "Message"("studentId", "gmailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffReply_clientKey_key" ON "StaffReply"("clientKey");

-- CreateIndex
CREATE INDEX "ApiUsage_createdAt_idx" ON "ApiUsage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FakeMail_draftId_key" ON "FakeMail"("draftId");

-- CreateIndex
CREATE INDEX "FakeMail_mailbox_seq_idx" ON "FakeMail"("mailbox", "seq");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cv" ADD CONSTRAINT "Cv_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessorList" ADD CONSTRAINT "ProfessorList_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Professor" ADD CONSTRAINT "Professor_listId_fkey" FOREIGN KEY ("listId") REFERENCES "ProfessorList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_listId_fkey" FOREIGN KEY ("listId") REFERENCES "ProfessorList"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_cvId_fkey" FOREIGN KEY ("cvId") REFERENCES "Cv"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Email" ADD CONSTRAINT "Email_professorId_fkey" FOREIGN KEY ("professorId") REFERENCES "Professor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only one email per student may be in flight, whatever the number of workers.
CREATE UNIQUE INDEX "one_sending_per_student" ON "Email" ("studentId") WHERE "status" = 'SENDING';
