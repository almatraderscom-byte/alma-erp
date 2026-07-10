'use client';

import React from 'react';

export interface IOSToggleProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    'onChange' | 'onClick' | 'role' | 'aria-checked'
  > {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * iOS 27 switch — 51x31pt track, 27pt white thumb.
 * Accessible: role="switch", aria-checked, native button keyboard handling.
 */
const IOSToggle = React.forwardRef<HTMLButtonElement, IOSToggleProps>(
  function IOSToggle({ checked, onChange, disabled, style, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        style={{
          position: 'relative',
          width: 51,
          height: 31,
          flexShrink: 0,
          padding: 0,
          border: 'none',
          borderRadius: 'var(--ios-radius-capsule)',
          background: checked ? 'var(--ios-green)' : 'var(--ios-toggle-off)',
          transition: 'background-color 200ms ease',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          WebkitTapHighlightColor: 'transparent',
          ...style,
        }}
        {...rest}
      >
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 2,
            left: 2,
            width: 27,
            height: 27,
            borderRadius: '50%',
            background: '#FFFFFF',
            boxShadow:
              '0 3px 8px rgba(0, 0, 0, 0.15), 0 1px 1px rgba(0, 0, 0, 0.16), 0 3px 1px rgba(0, 0, 0, 0.10)',
            transform: checked ? 'translateX(20px)' : 'translateX(0)',
            transition: 'transform 200ms ease',
          }}
        />
      </button>
    );
  }
);

export default IOSToggle;
