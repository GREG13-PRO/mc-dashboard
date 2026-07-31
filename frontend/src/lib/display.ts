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

export function applyDisplayPreferences(): void {
  applyTextSize(getTextSize());
  applyHighContrast(getHighContrast());
}
