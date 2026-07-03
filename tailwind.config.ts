import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        accent: {
          50: "#f1f0ff",
          100: "#e3e0ff",
          400: "#9b8cff",
          500: "#7c5cff",
          600: "#6438f5",
          700: "#5128cf",
        },
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(124,92,255,0.15), 0 8px 24px -8px rgba(124,92,255,0.25)",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in-scale": {
          "0%": { opacity: "0", transform: "scale(0.97)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "slide-up": {
          "0%": { opacity: "0", transform: "translateY(24px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.25s ease-out both",
        "fade-in-up": "fade-in-up 0.35s ease-out both",
        "fade-in-scale": "fade-in-scale 0.3s ease-out both",
        shimmer: "shimmer 1.6s linear infinite",
        "slide-up": "slide-up 0.4s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
