/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/ui/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        orange: {
          DEFAULT: '#ff8a00',
          50: 'rgba(255,138,0,0.05)',
          100: 'rgba(255,138,0,0.10)',
          200: 'rgba(255,138,0,0.20)',
          700: '#c86e00',
        },
        surface: {
          DEFAULT: '#171b24',
          dark: '#0f1117',
        },
        'border-dim': '#252b3a',
        dim: '#8a96ac',
        success: '#2dd47e',
        danger: '#ff5c5c',
        warn: '#ffd479',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        glass: '0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,138,0,0.15)',
        glow: '0 0 24px rgba(255,138,0,0.35)',
      },
    },
  },
  plugins: [],
}
