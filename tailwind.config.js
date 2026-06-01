/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,html}'],
  plugins: [require('daisyui')],
  daisyui: {
    themes: ['light'],
    logs: false,
  },
}
