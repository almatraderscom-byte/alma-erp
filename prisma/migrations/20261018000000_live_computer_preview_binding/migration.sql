-- Bind computer-use command audit rows to the agent activity that created them.
-- Nullable keeps every existing/manual producer compatible.
ALTER TABLE "live_browser_commands"
  ADD COLUMN "conversationId" TEXT,
  ADD COLUMN "turnId" TEXT,
  ADD COLUMN "contextId" TEXT,
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "mac_agent_commands"
  ADD COLUMN "conversationId" TEXT,
  ADD COLUMN "turnId" TEXT;

ALTER TABLE "mac_agent_frames"
  ADD COLUMN "conversationId" TEXT,
  ADD COLUMN "turnId" TEXT,
  ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "live_browser_commands_turnId_createdAt_idx"
  ON "live_browser_commands"("turnId", "createdAt");
CREATE INDEX "live_browser_commands_conversationId_createdAt_idx"
  ON "live_browser_commands"("conversationId", "createdAt");
CREATE INDEX "live_browser_commands_deviceId_contextId_createdAt_idx"
  ON "live_browser_commands"("deviceId", "contextId", "createdAt");
CREATE INDEX "mac_agent_commands_turnId_createdAt_idx"
  ON "mac_agent_commands"("turnId", "createdAt");
CREATE INDEX "mac_agent_commands_conversationId_createdAt_idx"
  ON "mac_agent_commands"("conversationId", "createdAt");
CREATE INDEX "mac_agent_frames_turnId_at_idx"
  ON "mac_agent_frames"("turnId", "at");
CREATE INDEX "mac_agent_frames_conversationId_at_idx"
  ON "mac_agent_frames"("conversationId", "at");

-- The Mac companion boundary is server/API-only. Protect its pairing secrets,
-- command/output audit, session text and automatic screen pixels from direct
-- Supabase anon/authenticated access. No client policies are intentional; the
-- established direct Prisma connection remains the authoritative path.
ALTER TABLE "mac_agent_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mac_agent_commands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mac_agent_session_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mac_agent_frames" ENABLE ROW LEVEL SECURITY;

-- Live Browser pixels are a latest-value side channel, never command history.
CREATE TABLE "live_browser_frames" (
  "deviceId" TEXT NOT NULL,
  "contextId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "dataUri" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "live_browser_frames_pkey" PRIMARY KEY ("deviceId", "contextId"),
  CONSTRAINT "live_browser_frames_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "live_browser_devices"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "live_browser_frames_turnId_capturedAt_idx"
  ON "live_browser_frames"("turnId", "capturedAt");
CREATE INDEX "live_browser_frames_conversationId_capturedAt_idx"
  ON "live_browser_frames"("conversationId", "capturedAt");

-- Screenshots are owner-private server data. Match the existing Browser device
-- and command tables: no client policy means Supabase anon/authenticated roles
-- fail closed while the server's direct Prisma connection remains authoritative.
ALTER TABLE "live_browser_frames" ENABLE ROW LEVEL SECURITY;

-- A short owner-renewed lease bounds background capture and binds every frame
-- to one still-running turn. One row per device prevents overlapping grants.
CREATE TABLE "live_browser_preview_leases" (
  "deviceId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "live_browser_preview_leases_pkey" PRIMARY KEY ("deviceId"),
  CONSTRAINT "live_browser_preview_leases_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "live_browser_devices"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "live_browser_preview_leases_turnId_expiresAt_idx"
  ON "live_browser_preview_leases"("turnId", "expiresAt");
CREATE INDEX "live_browser_preview_leases_conversationId_expiresAt_idx"
  ON "live_browser_preview_leases"("conversationId", "expiresAt");

ALTER TABLE "live_browser_preview_leases" ENABLE ROW LEVEL SECURITY;
