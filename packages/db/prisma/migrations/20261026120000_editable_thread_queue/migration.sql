ALTER TABLE "steering_messages"
  ADD COLUMN "deliveryMode" TEXT NOT NULL DEFAULT 'steer',
  ADD COLUMN "queuePosition" INTEGER,
  ADD COLUMN "cancelledAt" TIMESTAMP(3);
