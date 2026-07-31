import { en } from "../locales/en";
import { hu } from "../locales/hu";

/**
 * Translation lookup.
 *
 * English is the source of truth: every key exists there and `Locale` is typed
 * from it, so a key missing from another language is a compile error rather
 * than a blank label a user discovers.
 */
export type Locale = typeof en;
export type LocaleKey = keyof Locale;

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "hu", label: "Magyar" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

const STORAGE_KEY = "mc-dashboard-language";
const DICTIONARIES: Record<LanguageCode, Locale> = { en, hu };

function detect(): LanguageCode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "hu") return stored;
  // First run follows the browser so a Hungarian speaker is not made to switch
  // by hand, while English stays the default for everyone else.
  return navigator.language?.toLowerCase().startsWith("hu") ? "hu" : "en";
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
