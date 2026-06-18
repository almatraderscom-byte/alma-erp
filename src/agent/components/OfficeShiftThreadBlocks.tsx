'use client'

import { useState, type ReactNode } from 'react'
import AgentMarkdown from './AgentMarkdown'
import { formatDutyCostLineBangla } from '@/agent/lib/format-cost'

/** GPU-friendly collapse — grid 0fr↔1fr + opacity (~250ms ease-out). */
export function CollapsibleGrid({
  open,
  children,
  className = '',
}: {
  open: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`grid transition-[grid-template-rows,opacity] duration-[250ms] ease-out ${className}`}
      style={{
        gridTemplateRows: open ? '1fr' : '0fr',
        opacity: open ? 1 : 0,
      }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

export type OfficeShiftMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Recorded duty cost — shown under ✅ feedback lines. */
  costUsd?: number
}

export type OfficeTaskBlock = {
  id: string
  taskNumber: number
  label: string
  messages: OfficeShiftMessage[]
  status: 'running' | 'completed' | 'pending_approval'
}

const DUTY_START = /🏢 Sir, এখন করছি:\s*(.+)/i
const DUTY_DONE = /✅ Sir,.+শেষ/i
const DUTY_APPROVAL = /approval\s*লাগবে|⏳ Sir, এটা হয়নি/i

export function buildOfficeTaskBlocks(messages: OfficeShiftMessage[]): {
  preamble: OfficeShiftMessage[]
  blocks: OfficeTaskBlock[]
} {
  const preamble: OfficeShiftMessage[] = []
  const blocks: OfficeTaskBlock[] = []
  let current: OfficeTaskBlock | null = null
  let taskNumber = 0

  const flush = () => {
    if (current) {
      blocks.push(current)
      current = null
    }
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      flush()
      preamble.push(msg)
      continue
    }

    const startMatch = msg.text.match(DUTY_START)
    if (startMatch) {
      flush()
      taskNumber += 1
      current = {
        id: `office-task-${taskNumber}`,
        taskNumber,
        label: startMatch[1].trim(),
        messages: [msg],
        status: 'running',
      }
      continue
    }

    if (current) {
      current.messages.push(msg)
      if (DUTY_DONE.test(msg.text)) {
        current.status = 'completed'
        flush()
      } else if (DUTY_APPROVAL.test(msg.text)) {
        current.status = 'pending_approval'
      }
      continue
    }

    preamble.push(msg)
  }

  flush()
  return { preamble, blocks }
}

function formatBlockDuration(block: OfficeTaskBlock): string {
  if (block.status === 'running') return 'live'
  const mins = Math.max(1, Math.round((block.messages.length - 1) * 1.5))
  return `${mins}m`
}

function OfficeTaskBlockCard({
  block,
  defaultOpen,
  renderMessage,
}: {
  block: OfficeTaskBlock
  defaultOpen: boolean
  renderMessage: (msg: OfficeShiftMessage) => ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const completed = block.status === 'completed'
  const running = block.status === 'running'
  const duration = formatBlockDuration(block)

  return (
    <div
      className={`rounded-xl border overflow-hidden ${
        running
          ? 'border-amber-200/80 bg-amber-50/40 ring-1 ring-amber-200/50'
          : completed
            ? 'border-emerald-200/70 bg-emerald-50/30'
            : 'border-orange-200/70 bg-orange-50/30'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <span className="shrink-0 text-sm">{completed ? '✅' : running ? '🔄' : '⏳'}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-cream">
          কাজ #{block.taskNumber} — {block.label}
          <span className="font-normal text-muted"> · {duration}</span>
        </span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 text-muted transition-transform duration-[250ms] ${open ? 'rotate-180' : ''}`}
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <CollapsibleGrid open={open}>
        <div className="space-y-3 border-t border-border-subtle px-3 py-3">
          {block.messages.map((msg) => (
            <div key={msg.id}>{renderMessage(msg)}</div>
          ))}
        </div>
      </CollapsibleGrid>
    </div>
  )
}

function OfficeConversationBlock({
  messages,
  defaultOpen,
  renderMessage,
}: {
  messages: OfficeShiftMessage[]
  defaultOpen: boolean
  renderMessage: (msg: OfficeShiftMessage) => ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const turns = messages.length

  return (
    <div className="rounded-xl border border-indigo-200/70 bg-indigo-50/40 overflow-hidden ring-1 ring-indigo-200/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <span className="shrink-0 text-sm">💬</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#312e81]">
          Boss এর সাথে Conversation / Meeting
          <span className="font-normal text-[#6366f1]/70"> · {turns} বার্তা</span>
        </span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 text-[#818cf8] transition-transform duration-[250ms] ${open ? 'rotate-180' : ''}`}
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <CollapsibleGrid open={open}>
        <div className="space-y-3 border-t border-indigo-200/40 px-3 py-3">
          {messages.map((msg) => (
            <div key={msg.id}>{renderMessage(msg)}</div>
          ))}
        </div>
      </CollapsibleGrid>
    </div>
  )
}

export function OfficeShiftThreadRenderer({
  messages,
  renderUserMessage,
}: {
  messages: OfficeShiftMessage[]
  renderUserMessage: (msg: OfficeShiftMessage) => ReactNode
}) {
  const { preamble, blocks } = buildOfficeTaskBlocks(messages)

  const renderAssistant = (msg: OfficeShiftMessage) => (
    <div>
      <div className="text-[15px] leading-[1.7] text-cream break-words [overflow-wrap:anywhere]">
        <AgentMarkdown content={msg.text} />
      </div>
      {msg.costUsd != null && msg.costUsd >= 0 && DUTY_DONE.test(msg.text) && (
        <p className="mt-1.5 text-[11px] tabular-nums text-muted">
          {formatDutyCostLineBangla(msg.costUsd)}
        </p>
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      {/* Duty task cards (collapses) pinned ABOVE the conversation, so the
          owner's chat stays at the bottom (newest) instead of being pushed
          down by completed-work cards. */}
      {blocks.map((block) => (
        <OfficeTaskBlockCard
          key={block.id}
          block={block}
          defaultOpen={block.status === 'running'}
          renderMessage={(msg) =>
            msg.role === 'user' ? renderUserMessage(msg) : renderAssistant(msg)
          }
        />
      ))}
      {preamble.length > 0 && (
        <OfficeConversationBlock
          messages={preamble}
          defaultOpen={blocks.length === 0}
          renderMessage={(msg) =>
            msg.role === 'user' ? renderUserMessage(msg) : renderAssistant(msg)
          }
        />
      )}
    </div>
  )
}
