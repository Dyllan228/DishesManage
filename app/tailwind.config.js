/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./App.tsx', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        // 厨房暖色调：主色橙，辅助灰。与 Web 版 tailwind.config.js 数值一致，
        // 是同一个设计令牌，只是消费方从 CSS 变成了 NativeWind。
        brand: {
          50: '#fff7ed',
          100: '#ffedd5',
          200: '#fed7aa',
          300: '#fdba74',
          400: '#fb923c',
          500: '#f97316',
          600: '#ea580c',
          700: '#c2410c',
          800: '#9a3412',
          900: '#7c2d12',
        },
      },
      // 刻意**不**移植 Web 版的 fontFamily 栈（-apple-system / PingFang SC /
      // Microsoft YaHei…）：那些是 CSS 的候选字体表，安卓一个都不认，
      // 而安卓默认的 sans-serif 本来就是支持中文的思源黑体变体。
      // 写上去只会让读者以为字体被指定过。见 docs/决策记录.md D-024。
    },
  },
  plugins: [],
}
