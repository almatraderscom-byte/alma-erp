-- Employee payout / payment identity
CREATE TYPE "EmployeePaymentMethodType" AS ENUM ('MOBILE_BANKING', 'BANK_ACCOUNT');

CREATE TYPE "MobileMoneyProvider" AS ENUM ('BKASH', 'NAGAD', 'ROCKET', 'OTHER');

CREATE TYPE "PaymentAccountUsage" AS ENUM ('PERSONAL', 'BUSINESS');

CREATE TYPE "PaymentMethodStatus" AS ENUM ('ACTIVE', 'DISABLED', 'SUSPICIOUS', 'ARCHIVED');

CREATE TABLE "EmployeePaymentMethod" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "type" "EmployeePaymentMethodType" NOT NULL,
    "provider" "MobileMoneyProvider",
    "usageType" "PaymentAccountUsage",
    "accountHolderName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "bankName" TEXT,
    "branchName" TEXT,
    "routingNumber" TEXT,
    "qrImageUrl" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "status" "PaymentMethodStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspiciousNote" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeePaymentMethod_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmployeePaymentMethodAuditLog" (
    "id" TEXT NOT NULL,
    "paymentMethodId" TEXT,
    "userId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detailJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeePaymentMethodAuditLog_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EmployeePaymentMethod" ADD CONSTRAINT "EmployeePaymentMethod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmployeePaymentMethodAuditLog" ADD CONSTRAINT "EmployeePaymentMethodAuditLog_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "EmployeePaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "EmployeePaymentMethod_userId_businessId_isArchived_idx" ON "EmployeePaymentMethod"("userId", "businessId", "isArchived");
CREATE INDEX "EmployeePaymentMethod_userId_isPrimary_idx" ON "EmployeePaymentMethod"("userId", "isPrimary");
CREATE INDEX "EmployeePaymentMethod_businessId_status_idx" ON "EmployeePaymentMethod"("businessId", "status");
CREATE INDEX "EmployeePaymentMethodAuditLog_userId_createdAt_idx" ON "EmployeePaymentMethodAuditLog"("userId", "createdAt");

ALTER TABLE "WalletRequest" ADD COLUMN "paymentMethodId" TEXT;

CREATE INDEX "WalletRequest_paymentMethodId_idx" ON "WalletRequest"("paymentMethodId");
