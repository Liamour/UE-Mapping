/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  // 强制保留以下类名，严禁编译器剔除
  safelist: [
    'rounded-xl',
    'rounded-2xl',
    'rounded-3xl',
    'shadow-inner'
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
