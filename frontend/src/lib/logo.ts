/**
 * The mark.
 *
 * An isometric block with its top face lifted off it. The block says Minecraft
 * without being a grass texture, and the gap says the thing is being operated
 * on rather than just sitting there - which is what this dashboard is for.
 *
 * Three faces, three tones, one light source in the upper left. That is what
 * keeps it readable at 26px in the sidebar and still correct at 512px as an app
 * icon: the shape carries it, the shading only confirms it.
 *
 * Drawn rather than imported: an SVG in the bundle is one HTTP request and one
 * more thing that can 404, and this one needs a per-instance gradient id
 * anyway, since two copies on a page with the same id make the second one
 * inherit the first one's fill.
 */

let seq = 0;

export function logoMark(size = 26): string {
  // Gradients are referenced by id, and ids are global to the document; the
  // counter is what lets the sidebar and a dialog both draw the mark.
  const id = `lg${++seq}`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none"
     role="img" aria-label="Dashboard" class="logo-mark">
  <defs>
    <linearGradient id="${id}t" x1="4" y1="2" x2="28" y2="16" gradientUnits="userSpaceOnUse">
      <stop stop-color="#e2d2ff"/><stop offset="1" stop-color="#a855f7"/>
    </linearGradient>
    <linearGradient id="${id}r" x1="16" y1="11" x2="28" y2="30" gradientUnits="userSpaceOnUse">
      <stop stop-color="#a855f7"/><stop offset="1" stop-color="#7326d8"/>
    </linearGradient>
    <linearGradient id="${id}l" x1="4" y1="11" x2="16" y2="30" gradientUnits="userSpaceOnUse">
      <stop stop-color="#8b3dff"/><stop offset="1" stop-color="#4f18a6"/>
    </linearGradient>
  </defs>
  <path d="M4 11L16 18v12L4 23z" fill="url(#${id}l)"/>
  <path d="M28 11L16 18v12l12-7z" fill="url(#${id}r)"/>
  <path d="M16 2l12 7-12 7L4 9z" fill="url(#${id}t)"/>
</svg>`;
}

/**
 * The same mark as a standalone file, for anything outside the bundle: the
 * favicon, the web manifest, and the source the app icons are rendered from.
 */
export function logoSvgDocument(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${logoMark(32)
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>$/, "")}</svg>`;
}
