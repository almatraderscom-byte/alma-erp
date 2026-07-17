-- Phase 56 — personal/business OS service connections. Additive only.
-- CreateTable
CREATE TABLE "agent_service_connections" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "granted_ops" JSONB NOT NULL,
    "readiness" TEXT NOT NULL DEFAULT 'sandbox_pending',
    "health" JSONB,
    "retention_days" INTEGER NOT NULL DEFAULT 90,
    "connected_at" TIMESTAMP(3),
    "paused_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "data_deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_service_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_service_connections_service_key" ON "agent_service_connections"("service");

-- CreateIndex
CREATE INDEX "agent_service_connections_scope_status_idx" ON "agent_service_connections"("scope", "status");

