import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Wine-red palette mirrored from Shiny app.css :root variables.
        // --color-nav        #722F37
        // --color-nav-hover  #8B3A42
        // --color-nav-active #4A0E1A
        wine: {
          DEFAULT: "#722F37",
          hover: "#8B3A42",
          active: "#4A0E1A",
        },
      },
    },
  },
  plugins: [typography],
} satisfies Config;
