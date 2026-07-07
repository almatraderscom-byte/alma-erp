'use client';

import React from 'react';

export type IOSAccent =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'mint'
  | 'teal'
  | 'cyan'
  | 'blue'
  | 'indigo'
  | 'purple'
  | 'pink'
  | 'brown';

export type IOSButtonVariant =
  | 'filled'
  | 'tinted'
  | 'gray'
  | 'plain'
  | 'glass'
  | 'destructive';

export type IOSButtonSize = 'regular' | 'small';

export interface IOSButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. Defaults to 'filled'. */
  variant?: IOSButtonVariant;
  /** 'regular' = 44pt, 'small' = 34pt. Defaults to 'regular'. */
  size?: IOSButtonSize;
  /** Accent color name (e.g. 'green') — applied where the variant uses an accent. */
  tint?: IOSAccent;
}

const VARIANT_CLASS: Record<IOSButtonVariant, string> = {
  filled: 'ios-btn-filled',
  tinted: 'ios-btn-tinted',
  gray: 'ios-btn-gray',
  plain: 'ios-btn-plain',
  glass: 'ios-btn-glass lg-material',
  destructive: 'ios-btn-destructive',
};

function tintStyle(
  variant: IOSButtonVariant,
  tint?: IOSAccent
): React.CSSProperties | undefined {
  if (!tint) return undefined;
  const accent = `var(--ios-${tint})`;
  switch (variant) {
    case 'filled':
      return { background: accent };
    case 'tinted':
      return {
        background: `color-mix(in srgb, ${accent} 15%, transparent)`,
        color: accent,
      };
    case 'plain':
    case 'glass':
      return { color: accent };
    default:
      // gray / destructive keep their semantic colors.
      return undefined;
  }
}

const IOSButton = React.forwardRef<HTMLButtonElement, IOSButtonProps>(
  function IOSButton(
    { variant = 'filled', size = 'regular', tint, className, style, type, children, ...rest },
    ref
  ) {
    const classes = [
      'ios-btn',
      size === 'small' ? 'ios-btn-sm' : '',
      VARIANT_CLASS[variant],
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        className={classes}
        style={{ ...tintStyle(variant, tint), ...style }}
        {...rest}
      >
        {children}
      </button>
    );
  }
);

export default IOSButton;
