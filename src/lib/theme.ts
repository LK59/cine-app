export type AccentKey = "violet" | "blue" | "cyan" | "emerald" | "rose" | "amber";

export interface AccentPreset {
  key: AccentKey;
  label: string;
  /** RGB channels as "r g b" for CSS custom properties */
  c50: string;
  c100: string;
  c400: string;
  c500: string;
  c600: string;
  c700: string;
  hex: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { key: "violet",  label: "Violet",  c50: "240 237 255", c100: "225 218 255", c400: "155 140 255", c500: "124 92 255",  c600: "100 56 245", c700: "81 40 207",  hex: "#7c5cff" },
  { key: "blue",    label: "Bleu",    c50: "239 246 255", c100: "219 234 254", c400: "96 165 250",  c500: "59 130 246",  c600: "37 99 235",  c700: "29 78 216",  hex: "#3b82f6" },
  { key: "cyan",    label: "Cyan",    c50: "236 254 255", c100: "207 250 254", c400: "34 211 238",  c500: "6 182 212",   c600: "8 145 178",  c700: "14 116 144", hex: "#06b6d4" },
  { key: "emerald", label: "Vert",    c50: "236 253 245", c100: "209 250 229", c400: "52 211 153",  c500: "16 185 129",  c600: "5 150 105",  c700: "4 120 87",   hex: "#10b981" },
  { key: "rose",    label: "Rose",    c50: "255 241 242", c100: "255 228 230", c400: "251 113 133", c500: "244 63 94",   c600: "225 29 72",  c700: "190 18 60",  hex: "#f43f5e" },
  { key: "amber",   label: "Ambre",   c50: "255 251 235", c100: "254 243 199", c400: "251 191 36",  c500: "245 158 11",  c600: "217 119 6",  c700: "180 83 9",   hex: "#f59e0b" },
];

export const DEFAULT_ACCENT: AccentKey = "violet";
