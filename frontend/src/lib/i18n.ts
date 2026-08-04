import { en } from "../locales/en";
import { hu } from "../locales/hu";
import { de } from "../locales/de";
import { es } from "../locales/es";
import { fr } from "../locales/fr";
import { ptBR } from "../locales/pt-BR";
import { pl } from "../locales/pl";
import { ru } from "../locales/ru";
import { zhCN } from "../locales/zh-CN";

/**
 * Translation lookup.
 *
 * English is the source of truth: every key exists there and `Locale` is typed
 * from it. The other dictionaries are `Partial<Locale>`, so a missing key falls
 * back to English at runtime rather than failing to compile.
 *
 * That is a deliberate change from when there were two languages. With nine,
 * requiring every file to be complete means no string can be added without
 * translating it eight times in the same commit, and the pressure that creates
 * is to guess - which is how a dashboard ends up with confidently wrong German.
 * An English word on a German screen is a visible, honest gap;
 * tools/i18n-coverage.py is how those get found rather than discovered by a
 * user. A misspelled key is still a compile error, because Partial keeps the
 * key names typed.
 */
export type Locale = typeof en;
export type LocaleKey = keyof Locale;

/** Each label is written in its own language, which is how a picker is read. */
export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "hu", label: "Magyar" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "pl", label: "Polski" },
  { code: "ru", label: "Русский" },
  { code: "zh-CN", label: "简体中文" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

const STORAGE_KEY = "mc-dashboard-language";

const DICTIONARIES: Record<LanguageCode, Partial<Locale>> = {
  en,
  hu,
  de,
  es,
  fr,
  "pt-BR": ptBR,
  pl,
  ru,
  "zh-CN": zhCN,
};

const CODES: readonly string[] = LANGUAGES.map((l) => l.code);

function isSupported(code: string): code is LanguageCode {
  return CODES.includes(code);
}

/**
 * Maps a browser language tag onto one of ours.
 *
 * navigator.language gives a full tag - "pt-BR", "de-AT", "zh-Hans-CN" - and
 * only two of ours carry a region. So: exact match, then those two by prefix,
 * then the bare language.
 */
function match(tag: string): LanguageCode | null {
  const lower = tag.toLowerCase();
  for (const code of CODES) {
    if (code.toLowerCase() === lower) return code as LanguageCode;
  }
  if (lower.startsWith("pt")) return "pt-BR";
  // Traditional Chinese is not offered, so zh-TW and zh-HK fall through to
  // English rather than being served simplified characters.
  if (lower === "zh" || lower.startsWith("zh-hans") || lower.startsWith("zh-cn")) return "zh-CN";
  const base = lower.split("-")[0];
  return isSupported(base) ? base : null;
}

function detect(): LanguageCode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && isSupported(stored)) return stored;
  // First run follows the browser, in its own order of preference, so someone
  // whose second choice we speak is not made to switch by hand either.
  for (const tag of navigator.languages ?? [navigator.language]) {
    const found = tag ? match(tag) : null;
    if (found) return found;
  }
  return "en";
}

let current: LanguageCode = detect();

export function getLanguage(): LanguageCode {
  return current;
}

export function setLanguage(code: LanguageCode): void {
  current = code;
  localStorage.setItem(STORAGE_KEY, code);
  document.documentElement.lang = code;
}

export function applyLanguage(): void {
  document.documentElement.lang = current;
}

/** Falls back to English, then to the key itself, so a gap shows up as a
 * recognisable identifier rather than empty space. */
export function t(key: LocaleKey): string {
  return DICTIONARIES[current][key] ?? en[key] ?? String(key);
}
