import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        background: '#0B0B0D',
        foreground: '#F5F5F5',
        muted: '#1A1A1D',
        accent: '#C9A227'
      },
      fontFamily: {
        display: ['"Playfair Display"', 'serif'],
        body: ['"Noto Sans JP"', 'sans-serif']
      }
    }
  }
};

export default config;
