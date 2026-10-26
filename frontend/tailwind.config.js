/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: "#e8222d", dark: "#b8141e", darker: "#7f0d14" }, // Nagad-style red
        ink: "#1f2430",    // text
        muted: "#6b7280",  // secondary text
        line: "#e5e7eb",   // borders
        page: "#f5f6f8",   // page background
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", '"Segoe UI"', "Roboto", "sans-serif"],
        mono: ["ui-monospace", "Consolas", "monospace"],
      },
      gridTemplateColumns: {
        "auto-fit-320": "repeat(auto-fit, minmax(320px, 1fr))", // cards side by side, wrapping below 320px
      },
      boxShadow: {
        menu: "0 10px 30px rgba(17, 24, 39, 0.12)",
        modal: "0 20px 50px rgba(17, 24, 39, 0.3)",
        card: "0 10px 30px rgba(17, 24, 39, 0.06)",
        focus: "0 0 0 3px rgba(232, 34, 45, 0.15)",
      },
    },
  },
  plugins: [],
};
