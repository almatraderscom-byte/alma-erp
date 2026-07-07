import React from 'react';

export interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Frosted glass (sheets/bars/menus strength) instead of regular glass. */
  strong?: boolean;
  /**
   * Opaque classic inset-grouped card (var(--ios-grouped-secondary))
   * instead of Liquid Glass. Takes precedence over `strong`.
   */
  plain?: boolean;
  children?: React.ReactNode;
}

/**
 * iOS 27 Liquid Glass card. Regular glass by default; `strong` for the
 * frosted material; `plain` for the classic opaque inset-grouped look.
 */
export default function GlassCard({
  strong = false,
  plain = false,
  className,
  style,
  children,
  ...rest
}: GlassCardProps) {
  const material = plain ? '' : strong ? 'lg-material-strong' : 'lg-material';
  const classes = [material, className ?? ''].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      style={{
        borderRadius: 'var(--ios-radius-card)',
        ...(plain ? { background: 'var(--ios-grouped-secondary)' } : null),
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
