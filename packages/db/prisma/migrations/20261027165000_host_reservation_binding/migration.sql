ALTER TABLE "native_execution_reservations" ADD COLUMN "computerId" TEXT;
ALTER TABLE "native_execution_reservations" ADD COLUMN "computerKey" TEXT;
ALTER TABLE "native_execution_reservations" ADD COLUMN "hostId" TEXT;
ALTER TABLE "native_execution_reservations" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT false;
