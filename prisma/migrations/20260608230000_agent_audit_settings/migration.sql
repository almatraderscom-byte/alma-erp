-- Hermes agent API: audit log + settings version cache
CREATE TABLE "AgentAuditLog" (
    "id" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "resourceId" TEXT,
    "payload" JSONB,
    "actor" TEXT NOT NULL DEFAULT 'agent_via_sir',
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentAuditLog_actionType_createdAt_idx" ON "AgentAuditLog"("actionType", "createdAt");
CREATE INDEX "AgentAuditLog_createdAt_idx" ON "AgentAuditLog"("createdAt");
CREATE INDEX "AgentAuditLog_resourceId_idx" ON "AgentAuditLog"("resourceId");

CREATE TABLE "AgentSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "settingsVersion" INTEGER NOT NULL DEFAULT 1,
    "businessHours" JSONB,
    "holidays" JSONB,
    "lateThresholdMinutes" INTEGER NOT NULL DEFAULT 15,
    "finePolicy" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentSettings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "AgentSettings" ("id", "settingsVersion", "lateThresholdMinutes", "updatedAt", "createdAt")
VALUES ('global', 1, 15, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
