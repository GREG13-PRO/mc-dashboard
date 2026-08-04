import { icon } from "../lib/icons";
import { escapeHtml } from "../lib/escape";

/**
 * The card that introduces a screen: what it is, in one line, with its main
 * action beside it.
 *
 * These screens all opened with a bare title in a toolbar, which told you the
 * name of the thing you had just clicked and nothing else. The description is
 * the part that earns the space - "who did what, and when" is what an audit log
 * is, and a heading reading "Audit log" never said it.
 *
 * The server view keeps its toolbar instead: its controls are not one action
 * but a running/stopped state, and that belongs in something sticky.
 */
export interface PageHeadOptions {
  icon: string;
  title: string;
  description?: string;
  /** Markup, because callers need their own ids and classes on the buttons. */
  actions?: string;
}

export function pageHead(options: PageHeadOptions): string {
  return `
    <div class="page-head">
      <span class="page-head-icon">${icon(options.icon, 20)}</span>
      <div class="page-head-text">
        <h2>${escapeHtml(options.title)}</h2>
        ${options.description ? `<p>${escapeHtml(options.description)}</p>` : ""}
      </div>
      ${options.actions ? `<div class="page-head-actions">${options.actions}</div>` : ""}
    </div>`;
}
