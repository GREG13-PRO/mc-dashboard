/**
 * Renders Minecraft's § formatting codes to HTML.
 *
 * The MOTD is stored as one string with control characters in it - `§6Gold`
 * means the rest of the line is gold - and there is no way to know what a MOTD
 * will look like without doing what the client does. That is the entire point
 * of the preview: nobody types `§6` into a text box and knows what they will
 * get.
 *
 * The rules are the client's, not an approximation of them: a colour code
 * clears every style, a style code does not clear the colour, and `§r` clears
 * both. Getting that backwards is what makes a preview that lies.
 */

/** Minecraft's sixteen, as the client draws them on a dark background. */
export const COLOURS: { code: string; hex: string; name: string }[] = [
  { code: "0", hex: "#000000", name: "black" },
  { code: "1", hex: "#0000aa", name: "dark_blue" },
  { code: "2", hex: "#00aa00", name: "dark_green" },
  { code: "3", hex: "#00aaaa", name: "dark_aqua" },
  { code: "4", hex: "#aa0000", name: "dark_red" },
  { code: "5", hex: "#aa00aa", name: "dark_purple" },
  { code: "6", hex: "#ffaa00", name: "gold" },
  { code: "7", hex: "#aaaaaa", name: "gray" },
  { code: "8", hex: "#555555", name: "dark_gray" },
  { code: "9", hex: "#5555ff", name: "blue" },
  { code: "a", hex: "#55ff55", name: "green" },
  { code: "b", hex: "#55ffff", name: "aqua" },
  { code: "c", hex: "#ff5555", name: "red" },
  { code: "d", hex: "#ff55ff", name: "light_purple" },
  { code: "e", hex: "#ffff55", name: "yellow" },
  { code: "f", hex: "#ffffff", name: "white" },
];

export const STYLES: { code: string; key: string }[] = [
  { code: "l", key: "bold" },
  { code: "o", key: "italic" },
  { code: "n", key: "underline" },
  { code: "m", key: "strikethrough" },
  { code: "k", key: "obfuscated" },
];

const COLOUR_BY_CODE = new Map(COLOURS.map((c) => [c.code, c.hex]));

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface State {
  colour: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  obfuscated: boolean;
}

function fresh(): State {
  return {
    colour: null,
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    obfuscated: false,
  };
}

function spanFor(state: State, text: string): string {
  const style: string[] = [];
  if (state.colour) style.push(`color:${state.colour}`);
  if (state.bold) style.push("font-weight:700");
  if (state.italic) style.push("font-style:italic");
  const decoration = [
    state.underline ? "underline" : "",
    state.strikethrough ? "line-through" : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (decoration) style.push(`text-decoration:${decoration}`);
  const cls = state.obfuscated ? ' class="mc-obfuscated"' : "";
  return `<span${cls} style="${style.join(";")}">${escapeHtml(text)}</span>`;
}

/**
 * One line of MOTD as HTML. Newlines are the caller's business - the server
 * list draws two independent lines, not a wrapped paragraph.
 */
export function renderFormatted(line: string): string {
  let state = fresh();
  let buffer = "";
  let out = "";

  const flush = () => {
    if (buffer) {
      out += spanFor(state, buffer);
      buffer = "";
    }
  };

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch !== "§" || i === line.length - 1) {
      buffer += ch;
      continue;
    }
    const code = line[++i].toLowerCase();
    flush();
    if (code === "r") {
      state = fresh();
    } else if (COLOUR_BY_CODE.has(code)) {
      // A colour resets every style. This is the client's rule and it is the
      // one people get wrong when they hand-write a MOTD.
      state = { ...fresh(), colour: COLOUR_BY_CODE.get(code)! };
    } else {
      const style = STYLES.find((s) => s.code === code);
      if (style) {
        state = { ...state, [style.key]: true } as State;
      } else {
        // Not a code at all: keep both characters, because that is what the
        // client shows.
        buffer += `§${line[i]}`;
      }
    }
  }
  flush();
  return out;
}

/** Length as Minecraft counts it: the codes are part of the 59. */
export function visibleLength(line: string): number {
  return line.replace(/§./g, "").length;
}
