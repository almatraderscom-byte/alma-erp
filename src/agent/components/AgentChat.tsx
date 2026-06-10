'use client'

import { useState, useRef, useEffect, useCallback } from 'react'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
}

interface Conversation {
  id: string
  title: string | null
  updatedAt: string
}

interface AgentChatProps {
  userName: string
}

export default function AgentChat({ userName }: AgentChatProps) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [toolStatus, setToolStatus] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const loadConversations = useCallback(async () => {
    const res = await fetch('/api/assistant/conversations')
    if (res.ok) {
      const data: Conversation[] = await res.json()
      setConversations(data)
    }
  }, [])

  const loadMessages = useCallback(async (convId: string) => {
    const res = await fetch(`/api/assistant/conversations/${convId}/messages`)
    if (!res.ok) return
    const rows: Array<{
      id: string
      role: string
      content: Array<{ type: string; text?: string }>
      tokensIn: number | null
      tokensOut: number | null
      costUsd: string | null
    }> = await res.json()
    setMessages(
      rows.map((r) => ({
        id: r.id,
        role: r.role as 'user' | 'assistant',
        text: r.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
        tokensIn: r.tokensIn ?? undefined,
        tokensOut: r.tokensOut ?? undefined,
        costUsd: r.costUsd != null ? parseFloat(r.costUsd) : undefined,
      })),
    )
  }, [])

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, toolStatus])

  async function sendMessage() {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')
    setStreaming(true)
    setToolStatus(null)

    const userMsg: ChatMessage = { id: `tmp-${Date.now()}`, role: 'user', text }
    setMessages((prev) => [...prev, userMsg])

    let assistantMsgId = `streaming-${Date.now()}`
    setMessages((prev) => [...prev, { id: assistantMsgId, role: 'assistant', text: '' }])

    try {
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: activeConvId, message: text }),
      })

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentConvId = activeConvId

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n\n')
        buffer = lines.pop() ?? ''

        for (const chunk of lines) {
          if (!chunk.startsWith('data: ')) continue
          let evt: Record<string, unknown>
          try {
            evt = JSON.parse(chunk.slice(6))
          } catch {
            continue
          }

          if (evt.type === 'conversation_id') {
            currentConvId = evt.id as string
            setActiveConvId(currentConvId)
          } else if (evt.type === 'text_delta') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId ? { ...m, text: m.text + (evt.delta as string) } : m,
              ),
            )
          } else if (evt.type === 'tool_start') {
            setToolStatus(`🔧 ${evt.name as string}…`)
          } else if (evt.type === 'tool_end') {
            setToolStatus(null)
          } else if (evt.type === 'done') {
            assistantMsgId = evt.messageId as string
            setMessages((prev) =>
              prev.map((m) =>
                m.id.startsWith('streaming-')
                  ? {
                      ...m,
                      id: evt.messageId as string,
                      tokensIn: evt.tokensIn as number,
                      tokensOut: evt.tokensOut as number,
                      costUsd: evt.costUsd as number,
                    }
                  : m,
              ),
            )
            await loadConversations()
          } else if (evt.type === 'error') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, text: `⚠️ ${evt.message as string}` }
                  : m,
              ),
            )
          }
        }
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, text: `⚠️ ${err instanceof Error ? err.message : String(err)}` }
            : m,
        ),
      )
    } finally {
      setStreaming(false)
      setToolStatus(null)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  function selectConversation(conv: Conversation) {
    setActiveConvId(conv.id)
    loadMessages(conv.id)
  }

  function newConversation() {
    setActiveConvId(null)
    setMessages([])
    textareaRef.current?.focus()
  }

  const fmt = (n: number) => n.toLocaleString('en-US')
  const fmtCost = (n: number) => `$${n.toFixed(6)}`

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 120px)', gap: '1rem', fontFamily: 'var(--font-inter, sans-serif)' }}>
      {/* Sidebar */}
      <div style={{ width: '220px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <button
          onClick={newConversation}
          style={{
            padding: '0.5rem 0.75rem',
            background: '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: '0.85rem',
          }}
        >
          + নতুন কথোপকথন
        </button>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {conversations.map((c) => (
            <div
              key={c.id}
              onClick={() => selectConversation(c)}
              style={{
                padding: '0.5rem',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '0.8rem',
                background: c.id === activeConvId ? '#eff6ff' : 'transparent',
                borderLeft: c.id === activeConvId ? '3px solid #2563eb' : '3px solid transparent',
                marginBottom: '2px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {c.title ?? '(শিরোনাম নেই)'}
            </div>
          ))}
        </div>
      </div>

      {/* Chat area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' }}>
        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {messages.length === 0 && (
            <div style={{ color: '#9ca3af', textAlign: 'center', marginTop: '2rem', fontSize: '0.9rem' }}>
              আস্সালামু আলাইকুম, {userName}। কিভাবে সাহায্য করতে পারি?
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '75%',
              }}
            >
              <div
                style={{
                  padding: '0.6rem 0.9rem',
                  borderRadius: '12px',
                  background: m.role === 'user' ? '#2563eb' : '#f3f4f6',
                  color: m.role === 'user' ? '#fff' : '#111827',
                  fontSize: '0.9rem',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {m.text || (streaming && m.role === 'assistant' ? '▌' : '')}
              </div>
              {m.role === 'assistant' && m.tokensIn != null && (
                <div style={{ fontSize: '0.7rem', color: '#9ca3af', marginTop: '2px', paddingLeft: '2px' }}>
                  ↑{fmt(m.tokensIn)} ↓{fmt(m.tokensOut ?? 0)} • {fmtCost(m.costUsd ?? 0)}
                </div>
              )}
            </div>
          ))}
          {toolStatus && (
            <div style={{ alignSelf: 'flex-start', fontSize: '0.8rem', color: '#6b7280', fontStyle: 'italic' }}>
              {toolStatus}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div style={{ borderTop: '1px solid #e5e7eb', padding: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="বার্তা লিখুন… (Enter পাঠান, Shift+Enter নতুন লাইন)"
            disabled={streaming}
            rows={2}
            style={{
              flex: 1,
              resize: 'none',
              border: '1px solid #d1d5db',
              borderRadius: '8px',
              padding: '0.5rem 0.75rem',
              fontSize: '0.9rem',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || streaming}
            style={{
              padding: '0.5rem 1rem',
              background: !input.trim() || streaming ? '#d1d5db' : '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              cursor: !input.trim() || streaming ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              fontSize: '0.85rem',
              flexShrink: 0,
            }}
          >
            {streaming ? '…' : 'পাঠান'}
          </button>
        </div>
      </div>
    </div>
  )
}
