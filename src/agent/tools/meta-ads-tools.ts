// Meta Ads MCP bridged tools (Phase MA1) — READ-ONLY slice of Meta's official
// Ads MCP server (https://mcp.facebook.com/ads), wrapped as normal AgentTools
// by src/agent/lib/meta-mcp/bridge.ts. They ride in the `growth` tool-group so
// the state-router surfaces them on ads/marketing intents.
//
// Dormant + kill-switched (like WA_TOOLS): visible to the head always, but every
// handler checks META_MCP_ENABLED (env) + meta_mcp_enabled (kv) + the owner's
// OAuth connection before any network call, and answers in Bangla how to enable
// when it can't run. Write tools are NOT registered in MA1 — see bridge.ts.
import { createMetaAdsReadTools } from '@/agent/lib/meta-mcp/bridge'
import type { AgentTool } from './registry'

export const META_ADS_TOOLS: AgentTool[] = createMetaAdsReadTools()

/**
 * MA2: the catalog slice, also advertised via the `website` group so product /
 * stock / product-ads questions reach Meta's catalog truth. Same objects as in
 * META_ADS_TOOLS (deduped by name at assembly), so no double registration.
 */
export const META_ADS_CATALOG_TOOLS: AgentTool[] = META_ADS_TOOLS.filter((t) =>
  t.name.startsWith('meta_ads_catalog_'),
)
