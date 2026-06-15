/** Mirrors the agent_projects table. */
export interface Project {
  id: string
  name: string
  description: string | null
  systemInstructions: string | null
  createdAt: Date
  updatedAt: Date
}

/** Mirrors the agent_conversations table. */
export interface Conversation {
  id: string
  projectId: string | null
  title: string | null
  modelId: string
  archived: boolean
  createdAt: Date
  updatedAt: Date
}

/** A single content block within a message (text, tool_use, tool_result, image, etc.). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | ContentBlock[] }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/** Mirrors the agent_messages table. */
export interface Message {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'tool'
  content: ContentBlock[]
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
  createdAt: Date
}

/** Mirrors the agent_artifacts table. */
export interface Artifact {
  id: string
  conversationId: string
  messageId: string | null
  type: 'markdown' | 'code' | 'html' | 'image' | string | null
  title: string | null
  content: string | null
  version: number
  createdAt: Date
}

/** Mirrors the agent_memory table. */
export interface MemoryEntry {
  id: string
  scope: 'personal' | 'business' | 'staff' | string
  key: string | null
  content: string
  pinned: boolean
  metadata: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

/** Mirrors the agent_tool_calls table. */
export interface ToolCall {
  id: string
  messageId: string | null
  toolName: string
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null
  status: 'success' | 'error' | 'pending' | null
  durationMs: number | null
  error: string | null
  createdAt: Date
}
