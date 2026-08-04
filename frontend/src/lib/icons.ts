/**
 * Line icons, inline.
 *
 * Emoji were the obvious shortcut and the wrong one: they render as full-colour
 * pictures at a size the platform picks, differently on every OS, and they
 * cannot take the accent colour. These are stroked paths on a 24-grid that
 * inherit `currentColor`, so an icon in the sidebar is the same weight as the
 * text beside it and turns violet when its row is selected.
 *
 * Inline rather than a sprite sheet or a font: the whole set is under 2 kB, and
 * a template literal that returns markup fits how every view here is built.
 */

const PATHS: Record<string, string> = {
  // Navigation.
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  server:
    '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  sliders: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
  users:
    '<path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20"/><circle cx="9.5" cy="7" r="3.5"/><path d="M21 20v-1.5a4 4 0 0 0-3-3.9"/><path d="M16.5 3.6a3.5 3.5 0 0 1 0 6.8"/>',
  clipboard:
    '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 10h6M9 14h6M9 18h3"/>',
  download: '<path d="M12 3v12"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M4 20h16"/>',
  flask: '<path d="M10 3v6.5L4.6 18a2 2 0 0 0 1.7 3h11.4a2 2 0 0 0 1.7-3L14 9.5V3"/><path d="M8.5 3h7"/><path d="M7.4 14h9.2"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6"/><path d="M10.5 20a2 2 0 0 0 3 0"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7.5 9.5L10 12l-2.5 2.5"/><path d="M12.5 15h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17"/><path d="M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.4-3 8.2-7.5 9.5-4.5-1.3-7.5-5.1-7.5-9.5V6z"/>',
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l3.5-5"/><circle cx="12" cy="17" r="1.3"/>',

  // Controls.
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevronLeft: '<path d="M14.5 6L9 12l5.5 6"/>',
  chevronRight: '<path d="M9.5 6l5.5 6-5.5 6"/>',
  chevronDown: '<path d="M6 9.5l6 5.5 6-5.5"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h9"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  text: '<path d="M5 6V4.5h14V6"/><path d="M12 4.5V20"/><path d="M9 20h6"/>',
  home: '<path d="M4 10.5L12 4l8 6.5"/><path d="M6 9.5V20h12V9.5"/>',
};

/**
 * `stroke-width` is a hair under 2 so a 16px icon does not look heavier than
 * 500-weight text, which is what the sidebar rows use.
 */
export function icon(name: keyof typeof PATHS | string, size = 16): string {
  const path = PATHS[name] ?? PATHS.grid;
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
     aria-hidden="true" focusable="false">${path}</svg>`;
}

export type IconName = keyof typeof PATHS;
