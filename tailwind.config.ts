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
      },
      fontFamily: {
        mono: ['var(--font-mono)', 'JetBrains Mono', 'monospace'],
        sans: ['var(--font-sans)', 'Inter', 'system-ui', 'sans-serif'],
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
        'card':    '0 1px 3px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.6)',
      },
    },
  },
  plugins: [],
}
export default config
