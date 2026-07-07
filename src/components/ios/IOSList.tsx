'use client';

import React from 'react';

/* ── IOSList ─────────────────────────────────────────────────────────────── */

export interface IOSListProps {
  /** Uppercase section title rendered above the card. */
  header?: React.ReactNode;
  /** Footnote text rendered below the card. */
  footer?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/** Inset-grouped (Settings-style) list card. */
export function IOSList({ header, footer, className, style, children }: IOSListProps) {
  return (
    <div>
      {header != null && <div className="ios-section-title">{header}</div>}
      <div className={['ios-list', className ?? ''].filter(Boolean).join(' ')} style={style}>
        {children}
      </div>
      {footer != null && (
        <div
          className="ios-footnote"
          style={{
            color: 'var(--ios-label-secondary)',
            padding: '8px var(--ios-margin) 0',
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}

/* ── IOSListRow ──────────────────────────────────────────────────────────── */

export interface IOSListRowProps {
  /** Leading icon / glyph slot. */
  icon?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Trailing detail text (e.g. current value), label-secondary colored. */
  value?: React.ReactNode;
  /** Show a right disclosure chevron. */
  chevron?: boolean;
  onClick?: React.MouseEventHandler<HTMLElement>;
  /** Render the title in the destructive red. */
  destructive?: boolean;
  className?: string;
}

function Chevron() {
  return (
    <svg
      width="8"
      height="14"
      viewBox="0 0 8 14"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0, color: 'var(--ios-label-tertiary)' }}
    >
      <path
        d="M1 1l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A single row inside IOSList. Renders as a button when `onClick` is set. */
export function IOSListRow({
  icon,
  title,
  subtitle,
  value,
  chevron = false,
  onClick,
  destructive = false,
  className,
}: IOSListRowProps) {
  const classes = ['ios-list-row', className ?? ''].filter(Boolean).join(' ');

  const content = (
    <>
      {icon != null && (
        <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
          {icon}
        </span>
      )}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: destructive ? 'var(--ios-red)' : 'var(--ios-label)',
          }}
        >
          {title}
        </span>
        {subtitle != null && (
          <span
            className="ios-footnote"
            style={{
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--ios-label-secondary)',
            }}
          >
            {subtitle}
          </span>
        )}
      </span>
      {value != null && (
        <span
          style={{ color: 'var(--ios-label-secondary)', flexShrink: 0 }}
        >
          {value}
        </span>
      )}
      {chevron && <Chevron />}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={classes}
        style={{
          width: '100%',
          textAlign: 'left',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        {content}
      </button>
    );
  }

  return <div className={classes}>{content}</div>;
}
