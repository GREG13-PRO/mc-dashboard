/**
 * Jumping to a particular control, from anywhere.
 *
 * The hash carries the server and nothing else, so "go to PvP" has no address
 * to navigate to - and putting the tab in the hash would mean every tab click
 * tore the whole server view down and rebuilt it, which is a lot of machinery
 * to pay for a feature nobody asked for.
 *
 * So a jump is handed to the server view directly when the right one is already
 * on screen, and parked for it to collect when it is not. Two paths, because a
 * jump within the current server should not blink and a jump to another one has
 * to wait for something to mount.
 */

export interface Jump {
  serverId: string;
  /** Tab id, as ServerView knows them. */
  tab: string;
  /**
   * A control to single out once the tab is up - a property key, a game rule
   * name. The tab decides what to do with it; most filter their list to it and
   * flash the row.
   */
  focus?: string;
}

/** Returns true if it took the jump, so the sender knows not to park it. */
type Handler = (jump: Jump) => boolean;

const handlers = new Set<Handler>();
let parked: Jump | null = null;

export function onJump(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function jumpTo(jump: Jump): void {
  for (const handler of handlers) {
    if (handler(jump)) return;
  }
  // Nothing is mounted for that server yet. Park it and navigate; the view
  // collects it the moment it comes up.
  parked = jump;
  const target = `#/server/${encodeURIComponent(jump.serverId)}`;
  if (location.hash === target) {
    // Already there but unmounted - a hashchange would not fire, so nudge it.
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    location.hash = target;
  }
}

/**
 * Claims a parked jump, if it was meant for this server.
 *
 * Consumed rather than read, so a later remount does not replay a jump the
 * user has long since navigated away from.
 */
export function takeJump(serverId: string): Jump | null {
  if (!parked || parked.serverId !== serverId) return null;
  const jump = parked;
  parked = null;
  return jump;
}

/**
 * Draws attention to an element that has just been navigated to.
 *
 * Scrolling to it is not enough on a long form: the row arrives in the middle
 * of forty identical rows and the eye has nothing to catch. The class is
 * removed on animation end so a second jump to the same row plays again.
 */
export function flash(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add("jump-flash");
  el.addEventListener("animationend", () => el.classList.remove("jump-flash"), { once: true });
}
