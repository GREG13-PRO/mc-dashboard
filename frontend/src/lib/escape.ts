/**
 * Escapes text for interpolation into an HTML template literal, including
 * quotes so it is also safe inside an attribute value.
 *
 * Most data this dashboard renders is its own (server names, filenames), but
 * the plugin browser renders titles and descriptions straight from third-party
 * registries - that content is not ours and must never reach innerHTML raw.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
