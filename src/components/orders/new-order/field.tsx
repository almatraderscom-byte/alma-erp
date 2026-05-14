'use client'

export function NewOrderField({
  label,
  required,
  error,
  children,
  hint,
}: {
  label: string
  required?: boolean
  error?: string
  children: React.ReactNode
  hint?: string
}) {
  return (
    <div>
      <label className="block text-[10px] font-bold tracking-[0.12em] uppercase text-zinc-500 mb-1.5">
        {label}
        {required && <span className="text-gold ml-0.5">*</span>}
      </label>
      {children}
      {hint && !error && <p className="text-[10px] text-zinc-600 mt-1">{hint}</p>}
      {error && (
        <p className="text-[10px] text-red-400 mt-1 flex items-center gap-1">
          <span>⚠</span>
          {error}
        </p>
      )}
    </div>
  )
}

export const newOrderInputCls = (err?: string) =>
  `w-full bg-black/40 border rounded-xl px-3 py-2.5 text-sm text-cream placeholder-zinc-600 focus:outline-none transition-colors ${
    err ? 'border-red-400/60 focus:border-red-400' : 'border-border focus:border-gold-dim/70'
  }`

export const newOrderSelectCls = (err?: string) =>
  `w-full bg-black/40 border rounded-xl px-3 py-2.5 text-sm text-cream focus:outline-none transition-colors appearance-none cursor-pointer ${
    err ? 'border-red-400/60 focus:border-red-400' : 'border-border focus:border-gold-dim/70'
  }`
