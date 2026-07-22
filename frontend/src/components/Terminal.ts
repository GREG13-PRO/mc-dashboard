import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export class ConsoleTerminal {
  private term: Terminal;
  private fitAddon: FitAddon;
  private resizeObserver: ResizeObserver;
  private lastCols = 0;
  private lastRows = 0;

  constructor(
    container: HTMLElement,
    private onResize: (cols: number, rows: number) => void
  ) {
    this.term = new Terminal({
      convertEol: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      theme: { background: "#0a0b0d" },
      disableStdin: true,
      scrollback: 5000,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(container);
    this.fitAddon.fit();
    this.lastCols = this.term.cols;
    this.lastRows = this.term.rows;

    // screen redraws its whole buffer on every resize (SIGWINCH), so we must
    // only forward this when the terminal's dimensions actually changed -
    // otherwise a ResizeObserver that fires without a real size change would
    // trigger a full redraw loop that looks like the console endlessly
    // scrolling.
    this.resizeObserver = new ResizeObserver(() => {
      this.fitAddon.fit();
      const { cols, rows } = this.term;
      if (cols !== this.lastCols || rows !== this.lastRows) {
        this.lastCols = cols;
        this.lastRows = rows;
        this.onResize(cols, rows);
      }
    });
    this.resizeObserver.observe(container);
  }

  write(text: string) {
    // Force-follow the tail on every chunk. xterm.js only auto-scrolls when
    // the viewport is already exactly at the bottom, so a single accidental
    // scroll-up (mouse wheel, trackpad momentum) silently freezes the view
    // while new lines keep piling up below - this is a live console, so new
    // output should always win over a stale scroll position.
    this.term.write(text, () => this.term.scrollToBottom());
  }

  clear() {
    this.term.clear();
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.term.dispose();
  }
}
