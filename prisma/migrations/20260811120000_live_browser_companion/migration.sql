-- CreateTable
CREATE TABLE "live_browser_devices" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'My Chrome',
    "tokenHash" TEXT,
    "pairingCode" TEXT,
    "pairingExp" TIMESTAMP(3),
    "pairedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_browser_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_browser_commands" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "params" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "live_browser_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "live_browser_devices_tokenHash_key" ON "live_browser_devices"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "live_browser_devices_pairingCode_key" ON "live_browser_devices"("pairingCode");

-- CreateIndex
CREATE INDEX "live_browser_devices_ownerUserId_idx" ON "live_browser_devices"("ownerUserId");

-- CreateIndex
CREATE INDEX "live_browser_commands_deviceId_status_idx" ON "live_browser_commands"("deviceId", "status");

-- AddForeignKey
ALTER TABLE "live_browser_commands" ADD CONSTRAINT "live_browser_commands_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "live_browser_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- EnableRowLevelSecurity
-- These tables hold pairing token HASHES + queued automation commands. The app
-- reaches them only through Prisma's direct/service connection (which bypasses
-- RLS), so enabling RLS with NO policies fully blocks the Supabase anon/authenticated
-- roles — closing any accidental exposure via a client key. Mirrors the agent_* tables.
ALTER TABLE "live_browser_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "live_browser_commands" ENABLE ROW LEVEL SECURITY;
