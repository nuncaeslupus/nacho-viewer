// Every UI string lives in a locale file (D-14), so translations are added without touching the code.
import { bn } from "./locales/bn";
import { ca } from "./locales/ca";
import { de } from "./locales/de";
import { en, type Locale } from "./locales/en";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { hi } from "./locales/hi";
import { id } from "./locales/id";
import { it } from "./locales/it";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { pt } from "./locales/pt";
import { tr } from "./locales/tr";
import { vi } from "./locales/vi";
import { zh } from "./locales/zh";

/** The UI languages, each named in itself, in the order Settings › Language lists them (after
 * "System language"): Latin-script names alphabetically, then the others. */
export const LANGUAGES = {
  id: "Bahasa Indonesia",
  ca: "Català",
  de: "Deutsch",
  en: "English",
  es: "Español",
  fr: "Français",
  it: "Italiano",
  pt: "Português",
  vi: "Tiếng Việt",
  tr: "Türkçe",
  hi: "हिन्दी",
  bn: "বাংলা",
  zh: "中文",
  ja: "日本語",
  ko: "한국어",
} as const;
export type Language = keyof typeof LANGUAGES;

export const LOCALES: Record<Language, Locale> = {
  en,
  es,
  de,
  fr,
  it,
  pt,
  zh,
  ja,
  hi,
  bn,
  id,
  ko,
  tr,
  vi,
  ca,
};

/** Where the window keeps the language setting: strings are picked before the config is read. */
export const LANGUAGE_KEY = "nacho-viewer.language";

/** The setting (`auto` or a code) as a language: `auto` follows the system, then English. */
export function resolveLanguage(
  setting: string | null | undefined,
  system: readonly string[],
): Language {
  const known = (code: string) => (Object.hasOwn(LANGUAGES, code) ? (code as Language) : undefined);
  if (setting && setting !== "auto") return known(setting) ?? "en";
  for (const tag of system) {
    const code = known(tag.toLowerCase().split("-")[0]);
    if (code) return code;
  }
  return "en";
}

function storedSetting(): string | null {
  try {
    return localStorage.getItem(LANGUAGE_KEY);
  } catch {
    return null;
  }
}

export const language = resolveLanguage(storedSetting(), globalThis.navigator?.languages ?? []);

// Glyphs on the bar buttons; their labels above are the tooltips. One starting with "M" is
// SVG path data on Material Symbols' 960 grid (D-21).
export const icons = {
  // A window with a side panel on the left, like other apps' sidebar toggle.
  outline: "M120-800H840V-160H120ZM180-740V-220H330V-740H180ZM390-740V-220H780V-740H390Z",
  back: "←",
  forward: "→",
  zoomOut: "−",
  zoomIn: "+",
  // A wide page with triangles inside pushing the walls out (fill the window), or a narrow
  // column with triangles outside pushing in (fixed width). The toggle swaps them.
  sheetFill:
    "M120-840H840V-120H120ZM180-780V-180H780V-780H180ZM240-480L390-590L390-370ZM720-480L570-590L570-370Z",
  sheetFixed:
    "M330-840H630V-120H330ZM390-780V-180H570V-780H390ZM270-480L120-590L120-370ZM690-480L840-590L840-370Z",
  find: "M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-400q75 0 127.5-52.5T560-580q0-75-52.5-127.5T380-760q-75 0-127.5 52.5T200-580q0 75 52.5 127.5T380-400Z",
  findNext: "↓",
  findPrevious: "↑",
  findClose: "×",
  print:
    "M640-640v-120H320v120h-80v-200h480v200h-80Zm-480 80h640-640Zm560 100q17 0 28.5-11.5T760-500q0-17-11.5-28.5T720-540q-17 0-28.5 11.5T680-500q0 17 11.5 28.5T720-460Zm-80 260v-160H320v160h320Zm80 80H240v-160H80v-240q0-51 35-85.5t85-34.5h560q51 0 85.5 34.5T880-520v240H720v160Zm80-240v-160q0-17-11.5-28.5T760-560H200q-17 0-28.5 11.5T160-520v160h80v-80h480v80h80Z",
  closeTab: "×",
  newTab: "+",
  export:
    "M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z",
  minimize: "M240-460h480v-40H240Z",
  maximize: "M260-700h440v440H260Zm40 40v360h360v-360Z",
  restore: "M260-620h360v360H260Zm40 40v280h280v-280ZM340-700h360v360h-40v-320H340Z",
  closeWindow:
    "M291-263l-28-28 189-189-189-189 28-28 189 189 189-189 28 28-189 189 189 189-28 28-189-189Z",
  fileMenu: "M480-345 240-585l56-56 184 184 184-184 56 56-240 240Z",
  more: "M480-160q-33 0-56.5-23.5T400-240q0-33 23.5-56.5T480-320q33 0 56.5 23.5T560-240q0 33-23.5 56.5T480-160Zm0-240q-33 0-56.5-23.5T400-480q0-33 23.5-56.5T480-560q33 0 56.5 23.5T560-480q0 33-23.5 56.5T480-400Zm0-240q-33 0-56.5-23.5T400-720q0-33 23.5-56.5T480-800q33 0 56.5 23.5T560-720q0 33-23.5 56.5T480-640Z",
  diagramReset: "⟲",
};

export const strings = { ...LOCALES[language], icons };
