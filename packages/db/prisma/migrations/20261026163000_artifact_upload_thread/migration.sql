ALTER TABLE "artifacts" ADD COLUMN "uploadThreadId" TEXT;
CREATE INDEX "artifacts_uploadThreadId_idx" ON "artifacts"("uploadThreadId");
