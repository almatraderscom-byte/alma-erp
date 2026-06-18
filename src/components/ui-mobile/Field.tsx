'use client'

import { forwardRef, useId, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * `<Field>` wraps a label + control + error/hint with consistent spacing.
 * `<Input>` / `<Textarea>` / `<Select>` render at ≥16px so iOS never
 * auto-zooms on focus (the real auto-zoom fix — see ui-mobile/README.md).
 */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
  className,
}: {
  label?: string
  htmlFor?: string
  error?: string | null
  hint?: string
  required?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label != null && (
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-muted-hi">
          {label}
          {required && <span className="ml-0.5 text-danger">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-[12px] font-medium text-danger">{error}</p>
      ) : hint ? (
        <p className="text-[12px] text-muted">{hint}</p>
      ) : null}
    </div>
  )
}

const CONTROL_BASE =
  'w-full rounded-xl border bg-card px-4 text-[16px] text-cream placeholder-muted ' +
  'transition-colors focus:outline-none focus:border-gold/50 focus:ring-2 focus:ring-gold/15 ' +
  'disabled:opacity-50 disabled:bg-bg-2'

function controlClass(invalid?: boolean, extra?: string) {
  return cn(
    CONTROL_BASE,
    'min-h-[48px] py-3',
    invalid ? 'border-danger/60' : 'border-border-strong',
    extra,
  )
}

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...props },
  ref,
) {
  return <input ref={ref} className={controlClass(invalid, className)} {...props} />
})

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(CONTROL_BASE, 'min-h-[96px] resize-y py-3', invalid ? 'border-danger/60' : 'border-border-strong', className)}
      {...props}
    />
  )
})

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, invalid, children, ...props },
  ref,
) {
  return (
    <select ref={ref} className={cn(controlClass(invalid, className), 'cursor-pointer appearance-none')} {...props}>
      {children}
    </select>
  )
})

/** Convenience: a labelled text input in one shot. */
export const LabelledInput = forwardRef<HTMLInputElement, InputProps & { label?: string; error?: string | null; hint?: string }>(
  function LabelledInput({ label, error, hint, required, id, ...props }, ref) {
    const generatedId = useId()
    const fieldId = id ?? generatedId
    return (
      <Field label={label} htmlFor={fieldId} error={error} hint={hint} required={required}>
        <Input ref={ref} id={fieldId} required={required} invalid={Boolean(error)} {...props} />
      </Field>
    )
  },
)
