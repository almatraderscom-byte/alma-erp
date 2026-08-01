-- The live dock polls both command tables by createdAt every 3s while the agent
-- is working. Without these the poll degrades into a scan as history grows.
CREATE INDEX IF NOT EXISTS "mac_agent_commands_createdAt_idx" ON "mac_agent_commands"("createdAt");
CREATE INDEX IF NOT EXISTS "live_browser_commands_createdAt_idx" ON "live_browser_commands"("createdAt");
