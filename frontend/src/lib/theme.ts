export type ThemeChoice = "auto" | "light" | "dark";

const STORAGE_KEY = "mc-dashboard-theme";

export function getThemeChoice(): ThemeChoice {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "auto";
}

/**
 * Writes the choice onto <html>. "auto" removes the attribute entirely so the
 * stylesheet falls back to its prefers-color-scheme rules and keeps following
 * the system live, rather than freezing whatever the system was at load.
 */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "auto") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }
}

export function setThemeChoice(choice: ThemeChoice): void {
  localStorage.setItem(STORAGE_KEY, choice);
  applyTheme(choice);
}

/** Cycles auto -> light -> dark -> auto, which is the whole control surface. */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  return choice === "auto" ? "light" : choice === "light" ? "dark" : "auto";
}

export function themeLabel(choice: ThemeChoice): string {
  return { auto: "Rendszer", light: "Világos", dark: "Sötét" }[choice];
}

export function themeIcon(choice: ThemeChoice): string {
  return { auto: "◐", light: "☀", dark: "☾" }[choice];
}

/** Resolves what is actually on screen right now, for code that needs to pick
 * colours itself (the console ANSI palette). */
export function effectiveTheme(): "light" | "dark" {
  const choice = getThemeChoice();
  if (choice !== "auto") return choice;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Runs `onChange` whenever the effective theme changes - either because the
 * system flipped while on "auto", or because the user picked a mode. */
export function onThemeChange(handler: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", handler);
  window.addEventListener("mc-theme-change", handler);
  return () => {
    media.removeEventListener("change", handler);
    window.removeEventListener("mc-theme-change", handler);
  };
}

export function notifyThemeChanged(): void {
  window.dispatchEvent(new Event("mc-theme-change"));
}
