// Converts a single line of Minecraft/Log4j console output (which carries
// ANSI SGR color codes when the server thinks it's writing to a real
// terminal - see process-manager's TERM=xterm-256color) into styled HTML,
// for a plain scrolling log view rather than a full terminal emulator.

import { escapeHtml } from "./escape";

// Console colours are emitted as CSS variables rather than fixed hex so the
// same log is readable on both themes: the palette tuned for a dark terminal
// (pale greens, near-white) washes out completely on a light background. The
// two palettes live in style.css next to the rest of the tokens.
//
// Foreground 30-37/90-97 and background 40-47/100-107 index the same 16
// colours, so both maps point at one set of variables.
function ansiVar(index: number): string {
  return `var(--ansi-${index})`;
}

const FG_COLORS: Record<number, string> = Object.fromEntries([
  ...Array.from({ length: 8 }, (_, i) => [30 + i, ansiVar(i)]),
  ...Array.from({ length: 8 }, (_, i) => [90 + i, ansiVar(8 + i)]),
]);

const BG_COLORS: Record<number, string> = Object.fromEntries([
  ...Array.from({ length: 8 }, (_, i) => [40 + i, ansiVar(i)]),
  ...Array.from({ length: 8 }, (_, i) => [100 + i, ansiVar(8 + i)]),
]);

interface AnsiState {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const SGR_RE = /\x1b\[([0-9;]*)m/g;
// Any other CSI escape sequence (cursor movement, erase-line, etc.) - these
// only make sense against a live terminal grid, meaningless in a scrolling
// log, so they're dropped rather than rendered.
const OTHER_CSI_RE = /\x1b\[[0-9;?]*[A-LN-Za-ln-z]/g;

function styleFor(state: AnsiState): string {
  const parts: string[] = [];
  if (state.fg) parts.push(`color:${state.fg}`);
  if (state.bg) parts.push(`background-color:${state.bg}`);
  if (state.bold) parts.push("font-weight:600");
  if (state.italic) parts.push("font-style:italic");
  if (state.underline) parts.push("text-decoration:underline");
  return parts.join(";");
}

function applyCode(state: AnsiState, code: number): AnsiState {
  if (code === 0) return {};
  if (code === 1) return { ...state, bold: true };
  if (code === 3) return { ...state, italic: true };
  if (code === 4) return { ...state, underline: true };
  if (code === 22) return { ...state, bold: false };
  if (code === 23) return { ...state, italic: false };
  if (code === 24) return { ...state, underline: false };
  if (code === 39) return { ...state, fg: undefined };
  if (code === 49) return { ...state, bg: undefined };
  if (code in FG_COLORS) return { ...state, fg: FG_COLORS[code] };
  if (code in BG_COLORS) return { ...state, bg: BG_COLORS[code] };
  return state;
}

export function ansiLineToHtml(rawLine: string): string {
  const line = rawLine.replace(OTHER_CSI_RE, "");
  let state: AnsiState = {};
  let html = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  SGR_RE.lastIndex = 0;

  const appendSpan = (text: string) => {
    if (!text) return;
    const style = styleFor(state);
    html += style ? `<span style="${style}">${escapeHtml(text)}</span>` : escapeHtml(text);
  };

  while ((match = SGR_RE.exec(line))) {
    appendSpan(line.slice(lastIndex, match.index));
    const codes = match[1].split(";").filter(Boolean).map(Number);
    if (codes.length === 0) {
      state = {};
    } else {
      for (const code of codes) state = applyCode(state, code);
    }
    lastIndex = SGR_RE.lastIndex;
  }
  appendSpan(line.slice(lastIndex));

  return html;
}
