-- Phase 2: bind provider tokens to one authenticated app installation.
ALTER TABLE "office_call_devices" ADD COLUMN "installation_id" TEXT;

CREATE UNIQUE INDEX "office_call_devices_user_id_installation_id_provider_key"
  ON "office_call_devices"("user_id", "installation_id", "provider");
