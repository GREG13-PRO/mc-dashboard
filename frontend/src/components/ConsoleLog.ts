import { ansiLineToHtml } from "../lib/ansi";

const MAX_LINES = 3000;
// Consider the view "at the bottom" within this many pixels, so a little bit
// of scroll jitter doesn't spuriously break autoscroll.
const BOTTOM_THRESHOLD = 60;

export class ConsoleLogView {
  private logEl: HTMLDivElement;
  private scrollBtn: HTMLButtonElement;
  private buffer = "";
  private lineCount = 0;
  private autoScroll = true;

  constructor(container: HTMLElement) {
    container.classList.add("console-log-outer");
    container.innerHTML = `
      <div class="console-log"></div>
      <button class="console-scroll-btn" type="button">↓ Görgetés a legaljára</button>
    `;
    this.logEl = container.querySelector<HTMLDivElement>(".console-log")!;
    this.scrollBtn = container.querySelector<HTMLButtonElement>(".console-scroll-btn")!;

    this.logEl.addEventListener("scroll", () => {
      const nearBottom =
        this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < BOTTOM_THRESHOLD;
      this.autoScroll = nearBottom;
      this.scrollBtn.classList.toggle("visible", !nearBottom);
    });

    this.scrollBtn.addEventListener("click", () => {
      this.autoScroll = true;
      this.scrollToBottom();
      this.scrollBtn.classList.remove("visible");
    });
  }

  write(text: string) {
    this.buffer += text;
    const lastNewline = this.buffer.lastIndexOf("\n");
    if (lastNewline === -1) return;

    const complete = this.buffer.slice(0, lastNewline);
    this.buffer = this.buffer.slice(lastNewline + 1);

    const fragment = document.createDocumentFragment();
    for (const line of complete.split("\n")) {
      const div = document.createElement("div");
      div.className = "console-line";
      div.innerHTML = ansiLineToHtml(line) || "&nbsp;";
      fragment.appendChild(div);
      this.lineCount++;
    }
    this.logEl.appendChild(fragment);

    while (this.lineCount > MAX_LINES) {
      this.logEl.firstElementChild?.remove();
      this.lineCount--;
    }

    if (this.autoScroll) this.scrollToBottom();
  }

  scrollToBottom() {
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  clear() {
    this.logEl.innerHTML = "";
    this.buffer = "";
    this.lineCount = 0;
  }

  dispose() {
    // Nothing to tear down - no observers or timers held by this view.
  }
}
