import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        navy: {
          900: "var(--navy-900)",
          700: "var(--navy-700)",
          600: "var(--navy-600)",
        },
        accent: "var(--accent)",
        blue: {
          100: "var(--blue-100)",
          50: "var(--blue-50)",
        },
        ink: "var(--text)",
        muted: "var(--muted)",
        border: "var(--border)",
        success: "#16A34A",
        warning: "#D97706",
        danger: "#DC2626",
      },
      fontFamily: {
        sans: ["Inter", "Arial", "sans-serif"],
      },
      boxShadow: {
        panel: "0 8px 28px rgba(10, 26, 63, 0.07)",
      },
    },
  },
  plugins: [],
};

export default config;
