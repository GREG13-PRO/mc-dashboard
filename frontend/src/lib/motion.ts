/**
 * The two animations that cannot live in CSS.
 *
 * Everything else in this app animates through a stylesheet rule, which means
 * the `prefers-reduced-motion` block switches it all off in one place. These
 * two are driven from JavaScript - one counts a number, one staggers a list -
 * and a media query cannot stop a script, so they check for themselves.
 */

/** Read per call rather than cached: the setting can change while the tab is open. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Walks a number from one value to another.
 *
 * A CPU figure jumping 3% → 47% → 5% every five seconds reads as flicker; the
 * same values walked over a third of a second read as a measurement moving.
 * Only worth it for the large figures on the overview - a number small enough
 * to be a label is easier to read when it just changes.
 */
export function countUp(
  el: HTMLElement,
  from: number,
  to: number,
  format: (value: number) => string,
  durationMs = 320
): void {
  if (prefersReducedMotion() || from === to || !Number.isFinite(from)) {
    el.textContent = format(to);
    return;
  }

  // Written before the first frame, not on it. The caller has already redrawn
  // the element with the new value, so waiting for requestAnimationFrame lets
  // the destination flash for one frame before the count starts from the old
  // one - which is the opposite of the effect.
  el.textContent = format(from);

  const started = performance.now();
  const step = (now: number) => {
    // The element is replaced on every redraw, so a frame that arrives after
    // one has to stop rather than write into a detached node.
    if (!el.isConnected) return;
    const t = Math.min(1, (now - started) / durationMs);
    // Ease-out: fast at the start, settling at the end, which is how a value
    // arriving feels rather than a value being animated.
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * Brings a list in one row at a time.
 *
 * Deliberately not applied on every refresh. The server list rewrites itself
 * every five seconds, and a list that replays its entrance animation on a timer
 * is a list nobody can read. `seen` carries the ids that were already on screen,
 * so only genuinely new rows move - which also means a server appearing while
 * you watch is the one thing that draws the eye.
 */
export function staggerIn(items: HTMLElement[], seen: Set<string>, keyOf: (el: HTMLElement) => string): void {
  const present = new Set<string>();
  items.forEach((el) => {
    const key = keyOf(el);
    present.add(key);
    if (seen.has(key) || prefersReducedMotion()) return;
    el.classList.add("enter");
    // Capped: with forty servers the last one would otherwise arrive most of a
    // second after the first.
    el.style.setProperty("--enter-delay", `${Math.min(items.indexOf(el), 12) * 25}ms`);
    el.addEventListener("animationend", () => {
      el.classList.remove("enter");
      el.style.removeProperty("--enter-delay");
    }, { once: true });
  });

  // Forget rows that are gone, so a server removed and re-added animates again.
  for (const key of [...seen]) if (!present.has(key)) seen.delete(key);
  for (const key of present) seen.add(key);
}
