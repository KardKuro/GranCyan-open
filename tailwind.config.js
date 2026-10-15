/** @type {import('tailwindcss').Config} */
module.exports = {
  // 核心修改：让 Tailwind 去扫描你 HTML 文件里的 class 类名
  content: ["../*.html", "./*.html"], 
  theme: {
    extend: {},
  },
  plugins: [],
}