/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,html}'],
  theme: {
    extend: {
      colors: {
        'base-400': '#9ca3af',
        'base-500': '#6b7280',
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: ['light'],
    logs: false,
  },
}
