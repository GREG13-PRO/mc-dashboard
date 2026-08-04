import { api, ApiError } from "../api";
import { escapeHtml } from "../lib/escape";
import { t } from "../lib/i18n";
import { showToast } from "./Toast";
import { confirmModal } from "./Modal";
import { COLOURS, STYLES, renderFormatted, visibleLength } from "../lib/minecraft-format";

/**
 * The MOTD and the server icon, with a preview of the thing they end up in.
 *
 * Both were already reachable - the MOTD is a server.properties key and the
 * icon is a file - and both were unusable that way. `§6§lLobby` is not
 * something anyone composes in a text box, and nothing anywhere tells you the
 * icon has to be a 64x64 PNG named server-icon.png before the server will look
 * at it. The preview is the feature; the text field is just where the answer
 * lands.
 */

const STYLE_LABEL: Record<string, string> = {
  bold: "B",
  italic: "I",
  underline: "U",
  strikethrough: "S",
  obfuscated: "?",
};

export function renderMotdEditor(root: HTMLElement, serverId: string, serverName: string): void {
  let motd = "";
  let hasIcon = false;
  let maxLength = 118;

  function preview(): string {
    const [first = "", second = ""] = motd.split("\n");
    return `${renderFormatted(first)}<br>${renderFormatted(second) || "&nbsp;"}`;
  }

  /** Puts a code in at the caret, which is the only place it can mean anything. */
  function insert(code: string) {
    const field = root.querySelector<HTMLTextAreaElement>("#motd-input")!;
    const at = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? at;
    field.value = `${field.value.slice(0, at)}§${code}${field.value.slice(end)}`;
    motd = field.value;
    field.focus();
    field.setSelectionRange(at + 2, at + 2);
    update();
  }

  /** Redraws only what depends on the text, so typing does not lose the caret. */
  function update() {
    root.querySelector<HTMLElement>("#motd-preview-text")!.innerHTML = preview();
    const lines = motd.split("\n");
    const counter = root.querySelector<HTMLElement>("#motd-count")!;
    const longest = Math.max(...lines.map(visibleLength));
    counter.textContent = `${motd.length}/${maxLength} · ${t("leghosszabb_sor")}: ${longest}/59`;
    // 59 per line is where the client truncates; the whole-string cap is the
    // server's. Either one being close is worth saying before saving, not after.
    counter.classList.toggle("over", motd.length > maxLength || longest > 59);
  }

  function draw() {
    root.innerHTML = `
      <div class="motd-grid">
        <div class="motd-editor">
          <div class="field">
            <label for="motd-input">${t("motd_szoveg")}</label>
            <textarea id="motd-input" rows="2" spellcheck="false">${escapeHtml(motd)}</textarea>
            <p class="motd-count" id="motd-count"></p>
          </div>

          <label class="motd-palette-label">${t("szinek")}</label>
          <div class="motd-palette">
            ${COLOURS.map(
              (c) => `
              <button type="button" class="motd-swatch" data-code="${c.code}"
                      style="background:${c.hex}" title="§${c.code} ${c.name}"
                      aria-label="${c.name}"></button>`
            ).join("")}
          </div>

          <label class="motd-palette-label">${t("stilusok")}</label>
          <div class="motd-styles">
            ${STYLES.map(
              (s) => `
              <button type="button" class="btn motd-style motd-style-${s.key}" data-code="${s.code}"
                      title="§${s.code}">${STYLE_LABEL[s.key]}</button>`
            ).join("")}
            <button type="button" class="btn" data-code="r" title="§r">${t("formazas_torlese")}</button>
          </div>

          <div class="motd-actions">
            <button class="btn btn-primary" id="motd-save">${t("mentes")}</button>
          </div>
        </div>

        <div class="motd-side">
          <label class="motd-palette-label">${t("elonezet")}</label>
          <!-- The server list, as the client draws it: icon on the left, name
               and MOTD stacked to its right, on the client's own dark row. -->
          <div class="mc-list-row">
            <div class="mc-list-icon" id="motd-icon">
              ${
                hasIcon
                  ? `<img src="/api/servers/${encodeURIComponent(serverId)}/icon?t=${Date.now()}" alt="" />`
                  : `<div class="mc-list-icon-empty">?</div>`
              }
            </div>
            <div class="mc-list-text">
              <div class="mc-list-name">${escapeHtml(serverName)}</div>
              <div class="mc-list-motd" id="motd-preview-text"></div>
            </div>
            <div class="mc-list-ping">
              <span class="mc-bars"><i></i><i></i><i></i><i></i><i></i></span>
            </div>
          </div>

          <label class="motd-palette-label" style="margin-top:16px;">${t("szerverikon")}</label>
          <p class="finding-advice" style="margin:0 0 8px;">${t("szerverikon_leiras")}</p>
          <div class="motd-icon-actions">
            <label class="btn" for="icon-file">${t("ikon_feltoltese")}</label>
            <input type="file" id="icon-file" accept="image/png" hidden />
            ${hasIcon ? `<button class="btn btn-danger" id="icon-delete">${t("torles")}</button>` : ""}
          </div>
        </div>
      </div>
    `;

    const field = root.querySelector<HTMLTextAreaElement>("#motd-input")!;
    field.oninput = () => {
      motd = field.value;
      update();
    };
    // Two lines, and the client will not show a third.
    field.onkeydown = (e) => {
      if (e.key === "Enter" && field.value.includes("\n")) e.preventDefault();
    };

    root.querySelectorAll<HTMLButtonElement>("[data-code]").forEach((button) => {
      button.onclick = () => insert(button.dataset.code!);
    });

    root.querySelector<HTMLButtonElement>("#motd-save")!.onclick = async () => {
      try {
        const saved = await api.saveMotd(serverId, motd);
        motd = saved.motd;
        showToast(t("motd_mentve"));
        update();
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("mentes_sikertelen"), "error");
      }
    };

    const file = root.querySelector<HTMLInputElement>("#icon-file")!;
    file.onchange = async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      try {
        await api.uploadServerIcon(serverId, chosen);
        hasIcon = true;
        showToast(t("ikon_feltoltve"));
        draw();
        update();
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("feltoltes_sikertelen"), "error");
      } finally {
        file.value = "";
      }
    };

    root.querySelector<HTMLButtonElement>("#icon-delete")?.addEventListener("click", async () => {
      if (!(await confirmModal(t("biztosan_torlod_az_ikont")))) return;
      try {
        await api.deleteServerIcon(serverId);
        hasIcon = false;
        draw();
        update();
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("torles_sikertelen"), "error");
      }
    });

    update();
  }

  root.innerHTML = `<div class="empty-state" style="padding:16px;">${t("betoltes")}</div>`;
  void api
    .getMotd(serverId)
    .then((loaded) => {
      motd = loaded.motd;
      hasIcon = loaded.hasIcon;
      maxLength = loaded.maxLength;
      draw();
    })
    .catch((err) => {
      root.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
    });
}
