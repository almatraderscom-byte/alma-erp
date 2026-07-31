-- M1 (Mac control): pull-based command bus for the owner's own Mac.
-- Additive only — no existing table is touched.

CREATE TABLE "mac_agent_devices" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'My Mac',
    "tokenHash" TEXT,
    "pairingCode" TEXT,
    "pairingExp" TIMESTAMP(3),
    "pairedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mac_agent_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mac_agent_devices_tokenHash_key" ON "mac_agent_devices"("tokenHash");
CREATE UNIQUE INDEX "mac_agent_devices_pairingCode_key" ON "mac_agent_devices"("pairingCode");
CREATE INDEX "mac_agent_devices_ownerUserId_idx" ON "mac_agent_devices"("ownerUserId");

CREATE TABLE "mac_agent_commands" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "params" JSONB,
    "policyLevel" TEXT NOT NULL DEFAULT 'green',
    "approvedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "exitCode" INTEGER,
    "stdout" TEXT,
    "stderr" TEXT,
    "error" TEXT,
    "sessionKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "mac_agent_commands_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mac_agent_commands_deviceId_status_idx" ON "mac_agent_commands"("deviceId", "status");
CREATE INDEX "mac_agent_commands_sessionKey_idx" ON "mac_agent_commands"("sessionKey");

ALTER TABLE "mac_agent_commands" ADD CONSTRAINT "mac_agent_commands_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "mac_agent_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
