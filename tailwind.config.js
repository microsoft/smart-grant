/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        // ------------------------------------------------------------------
        // v2 — claude.com light palette
        // Used inside any subtree that carries the `.v2-root` class.
        // CSS variables live in globals.css under `.v2-root` so v1 surfaces
        // are 100% unaffected.
        // ------------------------------------------------------------------
        claude: {
          bg: 'rgb(var(--c-bg) / <alpha-value>)',
          surface: 'rgb(var(--c-surface) / <alpha-value>)',
          'surface-muted': 'rgb(var(--c-surface-muted) / <alpha-value>)',
          border: 'rgb(var(--c-border) / <alpha-value>)',
          'border-strong': 'rgb(var(--c-border-strong) / <alpha-value>)',
          'accent-muted': 'rgb(var(--c-accent-muted) / <alpha-value>)',
          text: 'rgb(var(--c-text) / <alpha-value>)',
          'text-muted': 'rgb(var(--c-text-muted) / <alpha-value>)',
          'text-subtle': 'rgb(var(--c-text-subtle) / <alpha-value>)',
          primary: 'rgb(var(--c-primary) / <alpha-value>)',
          'primary-hover': 'rgb(var(--c-primary-hover) / <alpha-value>)',
          'primary-soft': 'rgb(var(--c-primary-soft) / <alpha-value>)',
          success: 'rgb(var(--c-success) / <alpha-value>)',
          warning: 'rgb(var(--c-warning) / <alpha-value>)',
          danger: 'rgb(var(--c-danger) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['var(--font-serif)', 'Georgia', 'serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        'display': ['3.5rem', { lineHeight: '1.05', letterSpacing: '-0.02em' }],
        'display-sm': ['2.75rem', { lineHeight: '1.08', letterSpacing: '-0.02em' }],
        'h1': ['2.25rem', { lineHeight: '1.15', letterSpacing: '-0.015em' }],
        'h2': ['1.75rem', { lineHeight: '1.2', letterSpacing: '-0.01em' }],
        'h3': ['1.25rem', { lineHeight: '1.3', letterSpacing: '-0.005em' }],
      },
      boxShadow: {
        'c-1': '0 1px 2px rgb(11 31 51 / 0.04)',
        'c-2': '0 4px 12px rgb(11 31 51 / 0.06)',
        'c-3': '0 12px 32px rgb(11 31 51 / 0.08)',
        'c-focus': '0 0 0 3px rgb(46 124 228 / 0.25)',
      },
      borderRadius: {
        'c-sm': '8px',
        'c-md': '12px',
        'c-lg': '16px',
        'c-xl': '24px',
      },
      transitionTimingFunction: {
        'c-out': 'cubic-bezier(0.2, 0.7, 0.2, 1)',
      },
      transitionDuration: {
        'c-fast': '120ms',
        'c-base': '200ms',
        'c-slow': '360ms',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'bounce-slow': 'bounce 2s infinite',
        'fade-in': 'fade-in 360ms cubic-bezier(0.2, 0.7, 0.2, 1) both',
        'shimmer': 'shimmer 2.4s linear infinite',
        'pulse-soft': 'pulse-soft 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}

