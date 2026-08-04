import { api, ApiError } from "../api";
import { escapeHtml } from "../lib/escape";
import { t } from "../lib/i18n";
import { showToast } from "./Toast";

/**
 * LuckPerms' own web editor, inside the dashboard.
 *
 * It used to open in a new browser tab, and applying the result meant copying a
 * code out of it, finding the console tab and typing `lp applyedits <code>`.
 * Two context switches to change one permission.
 *
 * The editor is embedded rather than reimplemented for the same reason it was
 * linked before: it tracks LuckPerms' data model, and a copy here would have to
 * keep up with it forever. luckperms.net currently sends no X-Frame-Options and
 * no CSP frame-ancestors, so it can be framed - but that is somebody else's
 * header and it can change, so the server checks it each time and passes the
 * answer in as `embeddable`.
 *
 * The check has to happen on the server because the browser genuinely cannot
 * do it. A frame blocked by X-Frame-Options still fires `load` - it navigates
 * to the browser's own error page - and being cross-origin, nothing about its
 * contents is readable. The first version of this waited for a load event that
 * never failed to arrive, and it never once caught the case it was written for.
 */

/** Only a guard against a frame that hangs; a blocked one loads, it just loads
 *  an error page, and `embeddable` is what catches that. */
const LOAD_TIMEOUT_MS = 20000;

export function openLuckPermsEditor(
  serverId: string,
  url: string,
  embeddable: boolean
): () => void {
  const overlay = document.createElement("div");
  overlay.className = "lp-overlay";

  overlay.innerHTML = `
    <div class="lp-panel">
      <div class="lp-header">
        <strong>LuckPerms</strong>
        <div class="lp-header-actions">
          <a class="btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${t(
            "megnyitas_fulon"
          )}</a>
          <button class="btn" id="lp-close">${t("bezaras")}</button>
        </div>
      </div>

      <div class="lp-body">
        ${
          embeddable
            ? `<div class="lp-loading" id="lp-loading">${t("szerkeszto_betoltese")}</div>
               <iframe id="lp-frame" title="LuckPerms" src="${escapeHtml(url)}"
                       sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                       referrerpolicy="no-referrer"></iframe>`
            : `<div class="lp-loading lp-loading-failed" id="lp-loading">
                 <p>${t("lp_beagyazas_sikertelen")}</p>
                 <a class="btn btn-primary" href="${escapeHtml(url)}" target="_blank"
                    rel="noopener noreferrer">${t("megnyitas_fulon")}</a>
               </div>`
        }
      </div>

      <div class="lp-apply">
        <p class="lp-apply-hint">${t("lp_alkalmazas_leiras")}</p>
        <div class="lp-apply-row">
          <input id="lp-code" placeholder="${t("lp_kod_helye")}" autocomplete="off" spellcheck="false" />
          <button class="btn btn-primary" id="lp-apply">${t("modositasok_alkalmazasa")}</button>
        </div>
        <div id="lp-apply-result"></div>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const frame = overlay.querySelector<HTMLIFrameElement>("#lp-frame");
  const loading = overlay.querySelector<HTMLElement>("#lp-loading");
  const codeInput = overlay.querySelector<HTMLInputElement>("#lp-code")!;
  const applyBtn = overlay.querySelector<HTMLButtonElement>("#lp-apply")!;
  const applyResult = overlay.querySelector<HTMLElement>("#lp-apply-result")!;

  let loaded = false;
  const timer = frame
    ? setTimeout(() => {
        if (loaded) return;
        // Nothing at all came back. The link is more useful now than a frame
        // that is still thinking about it.
        frame.style.display = "none";
        loading!.className = "lp-loading lp-loading-failed";
        loading!.innerHTML = `
          <p>${t("lp_beagyazas_sikertelen")}</p>
          <a class="btn btn-primary" href="${escapeHtml(url)}" target="_blank"
             rel="noopener noreferrer">${t("megnyitas_fulon")}</a>`;
      }, LOAD_TIMEOUT_MS)
    : null;

  frame?.addEventListener("load", () => {
    loaded = true;
    if (timer) clearTimeout(timer);
    loading?.remove();
  });

  const close = () => {
    if (timer) clearTimeout(timer);
    overlay.remove();
    document.removeEventListener("keydown", onKeydown, true);
  };

  const onKeydown = (e: KeyboardEvent) => {
    // Only when focus is outside the frame; inside it the key belongs to the
    // editor, and the browser does not give us those events anyway.
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKeydown, true);

  overlay.querySelector<HTMLButtonElement>("#lp-close")!.onclick = close;
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  const apply = async () => {
    const code = codeInput.value.trim();
    if (!code) return;
    applyBtn.disabled = true;
    applyResult.innerHTML = `<p class="lp-apply-note">${t("alkalmazas_folyamatban")}</p>`;
    try {
      const { reply } = await api.applyLuckPermsEdits(serverId, code);
      applyResult.innerHTML = `<p class="lp-apply-note lp-apply-ok">${escapeHtml(reply)}</p>`;
      codeInput.value = "";
      showToast(t("modositasok_alkalmazva"));
    } catch (err) {
      applyResult.innerHTML = `<p class="lp-apply-note lp-apply-fail">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult")
      )}</p>`;
    } finally {
      applyBtn.disabled = false;
    }
  };

  applyBtn.onclick = () => void apply();
  codeInput.onkeydown = (e) => {
    if (e.key === "Enter") void apply();
  };

  return close;
}
