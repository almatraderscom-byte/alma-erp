import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        black:   '#08080A',
        surface: '#0F0F12',
        card:    '#141418',
        border:  '#1E1E24',
        gold:    '#C9A84C',
        'gold-lt':'#E8C96A',
        'gold-dim':'#8B6914',
        muted:   '#6B6B72',
        'muted-hi':'#9B9BA4',
        cream:   '#FAFAF8',
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
        'gold-shimmer': 'linear-gradient(90deg, transparent, rgba(201,168,76,0.2), transparent)',
      },
      boxShadow: {
        'gold-sm': '0 0 0 1px rgba(201,168,76,0.3)',
        'gold':    '0 0 0 1px rgba(201,168,76,0.5), 0 4px 24px rgba(201,168,76,0.1)',
        'card':    '0 2px 8px rgba(0,0,0,0.35), 0 1px 2px rgba(0,0,0,0.25)',
        'elevated': '0 8px 32px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.25)',
        'ambient': '0 4px 24px rgba(0,0,0,0.32)',
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
