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
