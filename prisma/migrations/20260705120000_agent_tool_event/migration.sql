-- CreateTable
CREATE TABLE "agent_tool_events" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "surface" TEXT NOT NULL DEFAULT 'owner',
    "tool_name" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "error_class" TEXT,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "conversation_id" TEXT,
    "business_id" TEXT NOT NULL DEFAULT 'ALMA_LIFESTYLE',

    CONSTRAINT "agent_tool_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_tool_events_ts_idx" ON "agent_tool_events"("ts");

-- CreateIndex
CREATE INDEX "agent_tool_events_tool_name_ts_idx" ON "agent_tool_events"("tool_name", "ts");

-- CreateIndex
CREATE INDEX "agent_tool_events_business_id_ts_idx" ON "agent_tool_events"("business_id", "ts");
