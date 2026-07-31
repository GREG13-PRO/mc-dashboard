import { api, ApiError } from "../api";
import { t } from "../lib/i18n";
import { escapeHtml } from "../lib/escape";
import type { AuditRecord } from "../types";

export function renderAuditView(root: HTMLElement): () => void {
  let disposed = false;
  let entries: AuditRecord[] = [];
  let filter = "";

  root.innerHTML = `<div class="empty-state">${t("betoltes")}</div>`;

  async function load() {
    try {
      entries = await api.listAudit(500);
      if (disposed) return;
      render();
    } catch (err) {
      root.innerHTML = `<div class="empty-state">${escapeHtml(
        err instanceof ApiError ? err.message : t("a_naplo_betoltese_sikertelen")
      )}</div>`;
    }
  }

  function render() {
    root.innerHTML = `
      <div class="server-view-header">
        <h2>${t("auditnaplo")}</h2>
        <div class="server-actions">
          <input id="audit-filter" placeholder="${t("szures_nev_muvelet_szerver")}" style="max-width:260px;" value="${escapeHtml(
            filter
          )}" />
          <button class="btn" id="audit-refresh">${t("frissites")}</button>
        </div>
      </div>
      <div class="tab-content"><div id="audit-list"></div></div>
    `;

    const input = root.querySelector<HTMLInputElement>("#audit-filter")!;
    input.oninput = () => {
      filter = input.value;
      renderList();
      // Re-rendering the whole header would drop focus mid-typing.
    };
    root.querySelector<HTMLButtonElement>("#audit-refresh")!.onclick = () => void load();
    renderList();
  }

  function renderList() {
    const list = root.querySelector<HTMLDivElement>("#audit-list");
    if (!list) return;

    const needle = filter.trim().toLowerCase();
    const shown = needle
      ? entries.filter((e) =>
          [e.actor, e.action, e.serverName ?? "", e.detail ?? ""].join(" ").toLowerCase().includes(needle)
        )
      : entries;

    if (shown.length === 0) {
      list.innerHTML = `<div class="empty-state" style="padding:1rem;">${
        entries.length === 0 ? t("a_naplo_meg_ures") : t("nincs_talalat")
      }</div>`;
      return;
    }

    list.innerHTML = `
      <table class="file-table">
        <thead>
          <tr><th>${t("idopont")}</th><th>${t("ki_oszlop")}</th><th>${t("muvelet")}</th><th>${t("szerver_oszlop")}</th><th>${t("reszlet")}</th><th>${t("eredmeny")}</th></tr>
        </thead>
        <tbody>
          ${shown
            .map(
              (e) => `
            <tr>
              <td style="white-space:nowrap;">${new Date(e.at).toLocaleString("hu-HU")}</td>
              <td>${escapeHtml(e.actor)}</td>
              <td>${escapeHtml(e.action)}</td>
              <td>${escapeHtml(e.serverName ?? "")}</td>
              <td>${escapeHtml(e.detail ?? "")}</td>
              <td style="color:${e.ok ? "var(--green)" : "var(--red)"};">${e.ok ? "ok" : "hiba"}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
      <p style="color:var(--text-dim);font-size:0.8rem;margin-top:0.8rem;">
        ${shown.length} bejegyzés${needle ? ` (${entries.length}-ből)` : ""}
      </p>
    `;
  }

  void load();

  return () => {
    disposed = true;
  };
}
