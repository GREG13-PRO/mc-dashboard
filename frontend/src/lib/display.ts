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

export function applyDisplayPreferences(): void {
  applyTextSize(getTextSize());
  applyHighContrast(getHighContrast());
  applyGlass(getGlass());
}
