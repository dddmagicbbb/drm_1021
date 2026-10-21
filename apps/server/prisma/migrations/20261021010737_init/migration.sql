-- CreateEnum
CREATE TYPE "SecurityLevel" AS ENUM ('NORMAL', 'CONFIDENTIAL');

-- CreateEnum
CREATE TYPE "SourceFormat" AS ENUM ('PDF', 'DOCX', 'XLSX', 'PPTX');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'CONVERTING', 'PACKAGED', 'FAILED');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('WINDOWS', 'WEB');

-- CreateEnum
CREATE TYPE "SubjectType" AS ENUM ('SENDER', 'RECIPIENT');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('SENDER', 'RECIPIENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('SENDER_LOGIN_SUCCEEDED', 'SENDER_LOGIN_FAILED', 'DISTRIBUTION_CREATED', 'DISTRIBUTION_UPDATED', 'DISTRIBUTION_REVOKED', 'RECIPIENT_ADDED', 'RECIPIENT_REMOVED', 'RECIPIENT_REVOKED', 'DOCUMENT_UPLOADED', 'DOCUMENT_PACKAGED', 'DOCUMENT_PACKAGING_FAILED', 'DOCUMENT_REVOKED', 'OTP_REQUESTED', 'OTP_VERIFIED', 'OTP_FAILED', 'DEVICE_REGISTERED', 'DEVICE_REVOKED', 'LICENSE_ISSUED', 'LICENSE_DENIED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "tokenHash" BYTEA NOT NULL,
    "family" UUID NOT NULL,
    "subjectType" "SubjectType" NOT NULL,
    "subjectId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipients" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distributions" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "allowWeb" BOOLEAN NOT NULL,
    "securityLevel" "SecurityLevel" NOT NULL,
    "offlineGraceHours" INTEGER NOT NULL,
    "maxViews" INTEGER,
    "maxDevices" INTEGER NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "distributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distribution_recipients" (
    "distributionId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "distribution_recipients_pkey" PRIMARY KEY ("distributionId","recipientId")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "distributionId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "sourceFormat" "SourceFormat" NOT NULL,
    "sourceSize" BIGINT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "failureReason" TEXT,
    "contentType" TEXT,
    "packagePath" TEXT,
    "packageSize" BIGINT,
    "wrappedCek" BYTEA,
    "kmsKeyId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "name" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licenses" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" BYTEA NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "type" "AuditEventType" NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "distributionId" UUID,
    "documentId" UUID,
    "recipientId" UUID,
    "deviceId" UUID,
    "ip" TEXT,
    "correlationId" TEXT,
    "detail" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens"("family");

-- CreateIndex
CREATE INDEX "refresh_tokens_subjectType_subjectId_idx" ON "refresh_tokens"("subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "recipients_email_key" ON "recipients"("email");

-- CreateIndex
CREATE INDEX "distributions_createdById_createdAt_idx" ON "distributions"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "distribution_recipients_recipientId_idx" ON "distribution_recipients"("recipientId");

-- CreateIndex
CREATE INDEX "documents_distributionId_idx" ON "documents"("distributionId");

-- CreateIndex
CREATE UNIQUE INDEX "devices_publicKey_key" ON "devices"("publicKey");

-- CreateIndex
CREATE INDEX "devices_recipientId_idx" ON "devices"("recipientId");

-- CreateIndex
CREATE INDEX "licenses_documentId_recipientId_idx" ON "licenses"("documentId", "recipientId");

-- CreateIndex
CREATE INDEX "otp_challenges_email_createdAt_idx" ON "otp_challenges"("email", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_occurredAt_idx" ON "audit_events"("occurredAt");

-- CreateIndex
CREATE INDEX "audit_events_distributionId_occurredAt_idx" ON "audit_events"("distributionId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_events_recipientId_occurredAt_idx" ON "audit_events"("recipientId", "occurredAt");

-- AddForeignKey
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distribution_recipients" ADD CONSTRAINT "distribution_recipients_distributionId_fkey" FOREIGN KEY ("distributionId") REFERENCES "distributions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distribution_recipients" ADD CONSTRAINT "distribution_recipients_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_distributionId_fkey" FOREIGN KEY ("distributionId") REFERENCES "distributions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 감사 로그 append-only 강제 (NFR-O1)
-- 애플리케이션 버그나 직접 접속으로도 기존 감사 이벤트를 수정·삭제할 수 없게 합니다.
CREATE OR REPLACE FUNCTION audit_events_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events는 append-only입니다 (% 거부)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_block_mutation();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_block_mutation();
