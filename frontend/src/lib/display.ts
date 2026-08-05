/**
 * Display preferences that sit alongside the theme: text size and a high
 * contrast mode.
 *
 * Both are attributes on <html> rather than classes on the app root, so they
 * apply to the modal and toast layers too - those are appended to <body> and
 * would otherwise keep the default styling.
 */

export type TextSize = "normal" | "large" | "xlarge";

const SIZE_KEY = "mc-dashboard-text-size";
const CONTRAST_KEY = "mc-dashboard-contrast";
const GLASS_KEY = "mc-dashboard-glass";

export function getTextSize(): TextSize {
  const stored = localStorage.getItem(SIZE_KEY);
  return stored === "large" || stored === "xlarge" ? stored : "normal";
}

export function setTextSize(size: TextSize): void {
  localStorage.setItem(SIZE_KEY, size);
  applyTextSize(size);
}

export function applyTextSize(size: TextSize): void {
  const root = document.documentElement;
  if (size === "normal") root.removeAttribute("data-text-size");
  else root.setAttribute("data-text-size", size);
}

export function nextTextSize(size: TextSize): TextSize {
  return size === "normal" ? "large" : size === "large" ? "xlarge" : "normal";
}

export function textSizeLabel(size: TextSize): string {
  return { normal: "Normál", large: "Nagy", xlarge: "Extra nagy" }[size];
}

export function getHighContrast(): boolean {
  return localStorage.getItem(CONTRAST_KEY) === "1";
}

export function setHighContrast(on: boolean): void {
  localStorage.setItem(CONTRAST_KEY, on ? "1" : "0");
  applyHighContrast(on);
}

export function applyHighContrast(on: boolean): void {
  const root = document.documentElement;
  if (on) root.setAttribute("data-contrast", "high");
  else root.removeAttribute("data-contrast");
}

/**
 * Glass on the floating surfaces. On by default - it is the look the app was
 * designed around - but the blur is the most expensive thing it draws, and on a
 * slower machine or for someone who would rather read flat text, one switch
 * turns all of it off. The stylesheet also drops it under high contrast and
 * under prefers-reduced-transparency, so this only has to cover the deliberate
 * choice.
 */
export function getGlass(): boolean {
  return localStorage.getItem(GLASS_KEY) !== "0";
}

export function setGlass(on: boolean): void {
  localStorage.setItem(GLASS_KEY, on ? "1" : "0");
  applyGlass(on);
}

export function applyGlass(on: boolean): void {
  const root = document.documentElement;
  // An attribute on <html> rather than a class on the app root: the modal and
  // toast layers are appended to <body> and would otherwise miss it.
  if (on) root.removeAttribute("data-glass");
  else root.setAttribute("data-glass", "off");
}

const SIMPLE_KEY = "mc-dashboard-simple";

/**
 * Beginner mode: six tabs instead of twenty-one.
 *
 * Not a separate application and not a reduced one - every tab it shows is the
 * same tab, with the same controls. It stops offering the fifteen that only
 * become interesting once something has gone wrong, which is the difference
 * between a first server taking five minutes and taking an afternoon of
 * reading tab names.
 *
 * Off by default rather than on. Someone already running servers here should
 * not lose half their interface to an update, and the first-run path turns it
 * on for a new installation where there is nobody to surprise - see
 * `adoptSimpleForNewcomers`.
 */
export function getSimpleMode(): boolean {
  return localStorage.getItem(SIMPLE_KEY) === "1";
}

export function setSimpleMode(on: boolean): void {
  localStorage.setItem(SIMPLE_KEY, on ? "1" : "0");
}

/**
 * Turns beginner mode on for a browser that has never expressed a preference
 * and is looking at an installation with no servers in it.
 *
 * The two conditions together are what make this safe: no stored answer means
 * nobody has chosen, and no servers means nobody has done anything yet either.
 * Called once, on the first server list that arrives.
 */
export function adoptSimpleForNewcomers(serverCount: number): boolean {
  if (localStorage.getItem(SIMPLE_KEY) !== null) return getSimpleMode();
  const simple = serverCount === 0;
  localStorage.setItem(SIMPLE_KEY, simple ? "1" : "0");
  return simple;
}

export function applyDisplayPreferences(): void {
  applyTextSize(getTextSize());
  applyHighContrast(getHighContrast());
  applyGlass(getGlass());
}
