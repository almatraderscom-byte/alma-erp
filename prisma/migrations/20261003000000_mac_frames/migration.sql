-- L7: live screen streaming — one newest-frame row per device.
CREATE TABLE "mac_agent_frames" (
    "deviceId" TEXT NOT NULL,
    "dataUri" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mac_agent_frames_pkey" PRIMARY KEY ("deviceId")
);
