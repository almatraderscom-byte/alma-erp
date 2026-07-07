'use client';

import React from 'react';

export interface IOSSegment<T extends string = string> {
  label: React.ReactNode;
  value: T;
}

export interface IOSSegmentedProps<T extends string = string> {
  segments: IOSSegment<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  style?: React.CSSProperties;
  /** Accessible name for the group. */
  'aria-label'?: string;
}

/**
 * iOS 27 segmented control with a sliding capsule thumb.
 * Equal-width segments; the thumb animates via CSS transform.
 */
export default function IOSSegmented<T extends string = string>({
  segments,
  value,
  onChange,
  className,
  style,
  'aria-label': ariaLabel,
}: IOSSegmentedProps<T>) {
  const count = Math.max(segments.length, 1);
  const selectedIndex = Math.max(
    0,
    segments.findIndex((s) => s.value === value)
  );

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={className}
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: `repeat(${count}, 1fr)`,
        background: 'var(--ios-fill-tertiary)',
        borderRadius: 'var(--ios-radius-capsule)',
        padding: 2,
        ...style,
      }}
    >
      {/* Sliding thumb */}
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 2,
          bottom: 2,
          left: 2,
          width: `calc((100% - 4px) / ${count})`,
          transform: `translateX(${selectedIndex * 100}%)`,
          transition: 'transform 200ms ease',
          background: 'var(--ios-segmented-selected)',
          borderRadius: 'var(--ios-radius-capsule)',
          boxShadow: '0 1px 4px rgba(0, 0, 0, 0.12), 0 0 1px rgba(0, 0, 0, 0.08)',
        }}
      />
      {segments.map((segment) => {
        const selected = segment.value === value;
        return (
          <button
            key={segment.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(segment.value)}
            className="ios-subheadline"
            style={{
              position: 'relative',
              zIndex: 1,
              minHeight: 36,
              padding: '0 10px',
              border: 'none',
              background: 'transparent',
              borderRadius: 'var(--ios-radius-capsule)',
              cursor: 'pointer',
              color: 'var(--ios-label)',
              fontWeight: selected ? 600 : 400,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}
