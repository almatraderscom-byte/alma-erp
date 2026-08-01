-- L4: CLI-session event stream from the Mac daemon, shown in the live dock.
CREATE TABLE "mac_agent_session_events" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tool" TEXT NOT NULL DEFAULT 'claude',
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT,
    "isError" BOOLEAN NOT NULL DEFAULT false,
    "costUsd" DOUBLE PRECISION,
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mac_agent_session_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mac_agent_session_events_sessionId_seq_key" ON "mac_agent_session_events"("sessionId", "seq");

CREATE INDEX "mac_agent_session_events_createdAt_idx" ON "mac_agent_session_events"("createdAt");
