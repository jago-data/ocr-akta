/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Same voice as the Nexus design system: white paper on a tinted desk,
        // navy for structure and data, red reserved for action and attention.
        canvas:  '#F4F6FA',
        paper:   '#FFFFFF',
        surface: '#F7F9FC',
        mute:    '#EDF1F7',
        line:    { DEFAULT: '#DBE2ED', soft: '#EAEFF6' },
        ink:     { DEFAULT: '#10203F', soft: '#55617C', faint: '#8892A8' },
        brand:   { DEFAULT: '#D42030', dark: '#A8182A', light: '#EE4257', tint: '#FDECEE' },
        navy:    { DEFAULT: '#16325C', dark: '#0E2244', light: '#3A5D96', tint: '#E9EFF9' },
        amber:   { DEFAULT: '#B0700A', tint: '#FFF3DF' },
        okay:    { DEFAULT: '#1B7F4B', tint: '#E7F6EE' },
        alert:   { DEFAULT: '#B3172B', tint: '#FDECEE' },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        panel: '0 1px 2px rgba(16,32,63,0.05), 0 8px 24px -16px rgba(16,32,63,0.22)',
        lift:  '0 2px 6px rgba(16,32,63,0.08), 0 16px 32px -20px rgba(16,32,63,0.32)',
        focus: '0 0 0 3px rgba(212,32,48,0.16)',
      },
      animation: {
        'fade-up':    'fadeUp .34s cubic-bezier(.2,.7,.3,1) both',
        'rise':       'rise .55s cubic-bezier(.16,.84,.34,1) both',
        'zoom-in':    'zoomIn .4s cubic-bezier(.16,.84,.34,1) both',
        'pulse-dot':  'pulseDot 1.4s ease-in-out infinite',
        'drift':      'drift 26s ease-in-out infinite alternate',
        'drift-slow': 'drift 38s ease-in-out infinite alternate-reverse',
        'ring':       'ring 2.8s ease-out infinite',
      },
      keyframes: {
        fadeUp: { '0%': { opacity: 0, transform: 'translateY(6px)' }, '100%': { opacity: 1, transform: 'none' } },
        rise:   { '0%': { opacity: 0, transform: 'translateY(14px)' }, '100%': { opacity: 1, transform: 'none' } },
        zoomIn: { '0%': { opacity: 0, transform: 'scale(.97) translateY(10px)' }, '100%': { opacity: 1, transform: 'none' } },
        pulseDot: { '0%,100%': { opacity: .4, transform: 'scale(.85)' }, '50%': { opacity: 1, transform: 'scale(1)' } },
        drift:  { '0%':   { transform: 'translate3d(0,0,0) scale(1)' },
                  '50%':  { transform: 'translate3d(3%,-2%,0) scale(1.06)' },
                  '100%': { transform: 'translate3d(-2%,3%,0) scale(1.03)' } },
        ring:   { '0%': { opacity: .5, transform: 'scale(1)' }, '70%,100%': { opacity: 0, transform: 'scale(2.4)' } },
      },
    },
  },
  plugins: [],
}
