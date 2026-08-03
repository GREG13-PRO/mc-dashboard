import { t } from "../lib/i18n";

/**
 * Renders a series as an inline SVG polyline.
 *
 * Inline SVG rather than canvas because the views that show these rewrite
 * their whole innerHTML on every refresh - a canvas would be discarded and
 * recreated blank on each tick, while a serialized SVG just reappears. It also
 * keeps the frontend dependency-free, which currently means one library total.
 */
export interface SparklineOptions {
  values: number[];
  color: string;
  width?: number;
  height?: number;
  /** Upper bound of the y-axis. Omit to scale to the data. */
  max?: number;
}

export function sparklineSvg({ values, color, width = 260, height = 44, max }: SparklineOptions): string {
  if (values.length === 0) {
    return `<div style="color:var(--text-dim);font-size:0.78rem;">${t("nincs_meg_adat")}</div>`;
  }

  const pad = 2;
  const top = max ?? Math.max(...values, 1);
  // A flat series would otherwise divide by zero and collapse onto one edge.
  const scale = top <= 0 ? 1 : top;
  const usableW = width - pad * 2;
  const usableH = height - pad * 2;

  // A single sample has no span to spread across, so it is drawn mid-width.
  const step = values.length > 1 ? usableW / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = pad + (values.length > 1 ? i * step : usableW / 2);
      const clamped = Math.max(0, Math.min(v, scale));
      const y = pad + usableH - (clamped / scale) * usableH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  // The fill polygon closes the line down to the baseline for a subtle area.
  const area = `${pad},${height - pad} ${points} ${(pad + (values.length > 1 ? usableW : usableW / 2)).toFixed(
    1
  )},${height - pad}`;

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none"
         style="display:block;overflow:visible;">
      <polygon points="${area}" fill="${color}" opacity="0.12" />
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.6"
                stroke-linejoin="round" stroke-linecap="round" />
    </svg>`;
}

export interface RatioBarOptions {
  /** 0..1 */
  ratio: number;
  label: string;
  /** Above this the bar turns to the warning colour. */
  warnAbove?: number;
  width?: number;
}

/**
 * A single proportion, drawn as a bar.
 *
 * The anti-cheat numbers are ratios, and a ratio is the one thing a table of
 * counts hides: "18 of 20" and "180 of 900" read the same in two columns and
 * mean completely different things. Same inline-SVG reasoning as the
 * sparkline - these views rewrite their innerHTML wholesale.
 */
export function ratioBarSvg({ ratio, label, warnAbove = 0.85, width = 160 }: RatioBarOptions): string {
  const height = 14;
  const clamped = Math.max(0, Math.min(1, ratio));
  const colour = clamped >= warnAbove ? "var(--red)" : "var(--accent)";
  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
         role="img" aria-label="${label}">
      <rect x="0" y="3" width="${width}" height="${height - 6}" rx="4"
            fill="var(--bg-inset)" />
      <rect x="0" y="3" width="${(width * clamped).toFixed(1)}" height="${height - 6}" rx="4"
            fill="${colour}" />
    </svg>`;
}
