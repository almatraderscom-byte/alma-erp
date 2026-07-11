'use client';

import React from 'react';

export interface IOSSheetProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

/**
 * iOS 27 bottom sheet: frosted Liquid Glass panel that slides up over a
 * dimmed backdrop. Closes on backdrop tap and Escape; locks body scroll
 * while open; respects prefers-reduced-motion; safe-area aware.
 */
export default function IOSSheet({
  open,
  onClose,
  title,
  children,
  className,
}: IOSSheetProps) {
  // Escape to close (client-only; effect never runs during SSR).
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Lock body scroll while open.
  React.useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
    >
      <style>{`
        @keyframes ios-sheet-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes ios-sheet-slide-up {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        .ios-sheet-backdrop { animation: ios-sheet-fade-in 250ms ease both; }
        .ios-sheet-panel { animation: ios-sheet-slide-up 320ms cubic-bezier(0.32, 0.72, 0, 1) both; }
        @media (prefers-reduced-motion: reduce) {
          .ios-sheet-backdrop, .ios-sheet-panel { animation: none; }
        }
      `}</style>

      {/* Backdrop */}
      <div
        className="ios-sheet-backdrop"
        onClick={onClose}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, background: 'var(--ios-overlay)' }}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        className={['ios-sheet-panel', 'lg-material-strong', className ?? '']
          .filter(Boolean)
          .join(' ')}
        style={{
          position: 'relative',
          borderRadius: 'var(--ios-radius-sheet) var(--ios-radius-sheet) 0 0',
          maxHeight: '92dvh',
          display: 'flex',
          flexDirection: 'column',
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)',
          overflow: 'hidden',
        }}
      >
        <div className="ios-grabber" style={{ flexShrink: 0 }} />
        {title != null && (
          <div
            className="ios-headline"
            style={{
              flexShrink: 0,
              textAlign: 'center',
              color: 'var(--ios-label)',
              padding: '8px var(--ios-margin) 12px',
            }}
          >
            {title}
          </div>
        )}
        <div
          style={{
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
            padding: '0 var(--ios-margin)',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
