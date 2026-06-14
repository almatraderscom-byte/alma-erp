/**
 * CS-1 isolated tool registry — customer agent MUST use only this module.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { CS_CUSTOMER_TOOLS, CS_CUSTOMER_TOOL_NAMES } from './cs-tools'
import type { AgentTool, ToolResult } from './registry'

export { CS_CUSTOMER_TOOL_NAMES }

export const CUSTOMER_SAFE_TOOLS: AgentTool[] = [...CS_CUSTOMER_TOOLS]

/** Exact allowed set for unit tests. */
export const CUSTOMER_SAFE_TOOL_NAMES: readonly string[] = CS_CUSTOMER_TOOL_NAMES

export const CUSTOMER_TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = CUSTOMER_SAFE_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}))

if (CUSTOMER_TOOL_DEFINITIONS.length > 0) {
  CUSTOMER_TOOL_DEFINITIONS[CUSTOMER_TOOL_DEFINITIONS.length - 1] = {
    ...CUSTOMER_TOOL_DEFINITIONS[CUSTOMER_TOOL_DEFINITIONS.length - 1],
    cache_control: { type: 'ephemeral' },
  } as Anthropic.Messages.Tool
}

export async function executeCsTool(
  name: string,
  input: Record<string, unknown>,
  serverContext: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tool = CUSTOMER_SAFE_TOOLS.find((t) => t.name === name)
  if (!tool) return { success: false, error: `Unknown CS tool: ${name}` }
  try {
    return await tool.handler({ ...input, ...serverContext })
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
