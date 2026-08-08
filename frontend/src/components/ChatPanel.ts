import { api, ApiError } from "../api";
import { escapeHtml } from "../lib/escape";
import { t } from "../lib/i18n";
import { icon } from "../lib/icons";
import { showToast } from "./Toast";
import type { ChatMessage } from "../types";

/**
 * The conversation, on its own screen.
 *
 * All of this was already on the console tab, mixed into the GC notices, the
 * plugin banners and whatever a mod logs every tick. Somebody asking a question
 * scrolled past in a second, and answering meant typing `say` into a box built
 * for `stop` and `op`.
 *
 * Polled rather than streamed, on the same three seconds the map uses for its
 * players. A second live channel carrying bytes the console tail already
 * carries would be two things to keep in step, and a chat window three seconds
 * behind is still a chat window.
 */

const POLL_MS = 3000;

const KIND_ICON: Record<ChatMessage["kind"], string> = {
  chat: "users",
  me: "users",
  join: "chevronRight",
  leave: "chevronLeft",
  death: "shield",
};

/**
 * A colour per name, from the name.
 *
 * The same hash the 3D map's markers use, so the person who is orange on the
 * map is orange here. Consistency between two screens showing the same people
 * is worth more than a prettier palette.
 */
function nameHue(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

function line(message: ChatMessage): string {
  const who = message.player
    ? `<span class="chat-name" style="color:hsl(${nameHue(message.player)} 62% 45%)">${escapeHtml(
        message.player
      )}</span>`
    : "";
  const body =
    message.kind === "chat"
      ? `${who}<span class="chat-text">${escapeHtml(message.text)}</span>`
      : message.kind === "me"
        ? `<span class="chat-text chat-emote">${who} ${escapeHtml(message.text)}</span>`
        : `<span class="chat-text chat-event">${escapeHtml(message.text)}</span>`;
  return `
    <div class="chat-line chat-${message.kind}">
      <span class="chat-time">${escapeHtml(message.at)}</span>
      <span class="chat-icon">${icon(KIND_ICON[message.kind], 13)}</span>
      <span class="chat-body">${body}</span>
    </div>`;
}

export function renderChat(root: HTMLElement, serverId: string, canSend: boolean): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  /** What was last drawn, so an unchanged poll does not rebuild the list. */
  let signature = "";

  root.innerHTML = `
    <div class="chat-root">
      <div class="chat-log" id="chat-log">
        <p class="empty-state" style="padding:16px;">${t("betoltes")}</p>
      </div>
      ${
        canSend
          ? `<form class="chat-send" id="chat-send">
               <input id="chat-input" type="text" maxlength="256" autocomplete="off"
                      placeholder="${escapeHtml(t("chat_uzenet_hely"))}" />
               <button class="btn btn-primary" type="submit">${escapeHtml(t("chat_kuldes"))}</button>
             </form>`
          : ""
      }
      <p class="chat-note">${escapeHtml(t("chat_forras"))}</p>
    </div>
  `;

  const log = root.querySelector<HTMLDivElement>("#chat-log")!;

  function draw(messages: ChatMessage[]) {
    const next = messages.map((m) => `${m.at}${m.kind}${m.player}${m.text}`).join("\n");
    if (next === signature) return;
    // Only stick to the bottom if that is where the reader already was -
    // scrolling someone back to the newest line while they are reading older
    // ones is how a chat window becomes unusable.
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    signature = next;
    log.innerHTML =
      messages.length === 0
        ? `<p class="empty-state" style="padding:16px;">${escapeHtml(t("chat_nincs_uzenet"))}</p>`
        : messages.map(line).join("");
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  async function load() {
    if (disposed) return;
    try {
      const messages = await api.getChat(serverId);
      if (!disposed) draw(messages);
    } catch (err) {
      if (disposed) return;
      log.innerHTML = `<p class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</p>`;
    }
  }

  const form = root.querySelector<HTMLFormElement>("#chat-send");
  const input = root.querySelector<HTMLInputElement>("#chat-input");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input?.value.trim() ?? "";
    if (!text) return;
    try {
      await api.sendChat(serverId, text);
      if (input) input.value = "";
      // Not appended locally: it has to come back through the log like every
      // other message, and showing it twice - or showing it when the send
      // silently failed - is worse than a three-second wait.
      void load();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
    }
  });

  void load();
  timer = setInterval(() => void load(), POLL_MS);

  return () => {
    disposed = true;
    if (timer) clearInterval(timer);
  };
}
