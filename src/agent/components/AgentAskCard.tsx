'use client'

export interface AskCard {
  id: string
  question: string
  options: string[]
}

interface AgentAskCardProps {
  card: AskCard
  onSelect: (option: string) => void
  disabled?: boolean
}

export default function AgentAskCard({ card, onSelect, disabled }: AgentAskCardProps) {
  return (
    <div className="mt-3 rounded-xl border border-blue-500/40 bg-blue-950/30 p-4 text-sm">
      <div className="mb-2 flex items-center gap-2 font-semibold text-blue-300">
        <span>❓</span>
        <span>একটি প্রশ্ন</span>
      </div>
      <p className="mb-3 text-gray-200 text-xs leading-relaxed">{card.question}</p>
      <div className="flex flex-col gap-2">
        {card.options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onSelect(opt)}
            disabled={disabled}
            className="rounded-lg border border-blue-500/30 bg-blue-900/40 px-4 py-2.5 text-left text-xs font-medium text-blue-100 transition-colors hover:bg-blue-800/50 disabled:opacity-50"
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  )
}
