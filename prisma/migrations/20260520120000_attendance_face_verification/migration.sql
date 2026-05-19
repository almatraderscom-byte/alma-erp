-- Attendance face verification (lightweight thumb only)
ALTER TABLE "AttendanceRecord" ADD COLUMN "faceVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AttendanceRecord" ADD COLUMN "faceVerifiedAt" TIMESTAMP(3);
ALTER TABLE "AttendanceRecord" ADD COLUMN "faceThumbDataUrl" TEXT;

ALTER TYPE "TelegramNotificationEventType" ADD VALUE 'ATTENDANCE_FACE_VERIFIED_CHECK_IN';
