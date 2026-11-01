/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3390ec', /* Telegram Blue */
          600: '#2b7cdb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
          950: '#172554',
        },
        messenger: {
          bg: 'var(--msg-bg)',
          sidebar: 'var(--msg-sidebar)',
          chat: 'var(--msg-chat)',
          input: 'var(--msg-input)',
          hover: 'var(--msg-hover)',
          border: 'var(--msg-border)',
          divider: 'var(--msg-divider)',
          text: 'var(--msg-text)',
          muted: 'var(--msg-muted)',
          accent: 'var(--msg-accent)',
          'msg-own': 'var(--msg-own)',
          'msg-other': 'var(--msg-other)',
          'msg-text-own': 'var(--msg-text-own)',
          'msg-text-other': 'var(--msg-text-other)',
          'msg-time-own': 'var(--msg-time-own)',
          'msg-time-other': 'var(--msg-time-other)',
        }
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', '"Apple Color Emoji"', '"Segoe UI"', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', '"Fira Sans"', '"Droid Sans"', '"Helvetica Neue"', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'bounce-slow': 'bounce 2s infinite',
      },
      maxWidth: {
        'messenger': '100%',
        'telegram': '1680px',
      },
      boxShadow: {
        'telegram': '0 1px 2px rgba(114, 114, 114, 0.25)',
      }
    },
  },
  plugins: [],
}
