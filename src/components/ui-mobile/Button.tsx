'use client'

import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'md' | 'lg'

export type MobileButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  size?: Size
  /** Stretch to fill the row — the default touch-friendly form button. */
  fullWidth?: boolean
  loading?: boolean
}

const VARIANTS: Record<Variant, string> = {
  // Brand coral. Solid fill for the primary action.
  primary: 'bg-gold text-white hover:bg-gold-dim active:bg-gold-dim shadow-card',
  secondary: 'bg-card text-cream border border-border-strong hover:bg-bg-2 active:bg-bg-3',
  ghost: 'bg-transparent text-muted-hi hover:bg-white/[0.04] active:bg-white/[0.06]',
  danger: 'bg-danger text-white hover:opacity-90 active:opacity-90',
}

const SIZES: Record<Size, string> = {
  // 44px = Apple's minimum touch target. Never go below this on mobile.
  md: 'min-h-[44px] px-4 text-[15px]',
  lg: 'min-h-[52px] px-5 text-base',
}

/**
 * The standard tappable button. Always ≥44px tall, clear pressed state,
 * optional full-width. Uses brand tokens only.
 */
export const Button = forwardRef<HTMLButtonElement, MobileButtonProps>(function Button(
  { variant = 'primary', size = 'md', fullWidth, loading, disabled, className, children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex select-none items-center justify-center gap-2 rounded-xl font-semibold',
        'transition-[transform,background-color,opacity] duration-150 active:scale-[0.98]',
        'disabled:pointer-events-none disabled:opacity-40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40',
        SIZES[size],
        VARIANTS[variant],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {loading && (
        <span
          aria-hidden
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
        />
      )}
      {children}
    </button>
  )
})
