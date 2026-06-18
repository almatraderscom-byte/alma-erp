import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Channel-format tokens (rgb(var / <alpha-value>)) so opacity modifiers
        // like bg-gold/10 keep working AND recolor per theme. See globals.css.
        black:   'rgb(var(--c-black) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        card:    'rgb(var(--c-card) / <alpha-value>)',
        border:  'var(--border)',
        gold:    'rgb(var(--c-accent) / <alpha-value>)',
        'gold-lt':'rgb(var(--c-accent-lt) / <alpha-value>)',
        'gold-dim':'rgb(var(--c-accent-dim) / <alpha-value>)',
        muted:   'rgb(var(--c-muted) / <alpha-value>)',
        'muted-hi':'rgb(var(--c-muted-hi) / <alpha-value>)',
        cream:   'rgb(var(--c-ink) / <alpha-value>)',
        'bg-0': 'var(--bg-0)',
        'bg-1': 'var(--bg-1)',
        'bg-2': 'var(--bg-2)',
        'bg-3': 'var(--bg-3)',
        'border-subtle': 'var(--border-subtle)',
        'border-strong': 'var(--border-strong)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
        info: 'var(--info)',
      },
      borderRadius: {
        sm: '10px',
        DEFAULT: '14px',
        lg: '20px',
        xl: '26px',
      },
      fontFamily: {
        mono: ['var(--font-mono)', 'JetBrains Mono', 'monospace'],
        sans: [
          'var(--font-inter)',
          'var(--font-bengali)',
          'var(--font-hind)',
          'Inter',
          'Noto Sans Bengali',
          'Hind Siliguri',
          'system-ui',
          'sans-serif',
        ],
      },
      animation: {
        'fade-up':    'fadeUp 0.4s ease forwards',
        'fade-in':    'fadeIn 0.3s ease forwards',
        'slide-right':'slideRight 0.3s ease forwards',
        'pulse-slow': 'pulse 3s ease-in-out infinite',
        'shimmer':    'shimmer 2s linear infinite',
      },
      keyframes: {
        fadeUp:     { from:{ opacity:'0', transform:'translateY(12px)' }, to:{ opacity:'1', transform:'translateY(0)' } },
        fadeIn:     { from:{ opacity:'0' }, to:{ opacity:'1' } },
        slideRight: { from:{ transform:'translateX(100%)' }, to:{ transform:'translateX(0)' } },
        shimmer:    { '0%':{ backgroundPosition:'-200% 0' }, '100%':{ backgroundPosition:'200% 0' } },
      },
      backgroundImage: {
        'gold-shimmer': 'linear-gradient(90deg, transparent, rgba(224,122,95,0.12), transparent)',
      },
      boxShadow: {
        'gold-sm': '0 0 0 1px rgba(224,122,95,0.25)',
        'gold':    '0 0 0 1px rgba(224,122,95,0.3), 0 4px 24px rgba(224,122,95,0.08)',
        'card':    '0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.03)',
        'elevated': '0 4px 16px rgba(0,0,0,0.06), 0 2px 6px rgba(0,0,0,0.04)',
        'ambient': '0 2px 12px rgba(0,0,0,0.05)',
      },
      fontSize: {
        'display-1': ['1.75rem', { lineHeight: '1.15', fontWeight: '700', letterSpacing: '-0.02em' }],
        'display-2': ['1.375rem', { lineHeight: '1.2', fontWeight: '700', letterSpacing: '-0.015em' }],
        'display-3': ['1.125rem', { lineHeight: '1.25', fontWeight: '600' }],
        'display-4': ['1rem', { lineHeight: '1.3', fontWeight: '600' }],
        caption: ['0.6875rem', { lineHeight: '1.35', letterSpacing: '0.04em' }],
      },
    },
  },
  plugins: [],
}
export default config
