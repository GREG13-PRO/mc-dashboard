import { api, ApiError } from "../api";
import { showToast } from "./Toast";
import { escapeHtml } from "../lib/escape";
import type { PluginSearchResult, PluginSource, PluginVersionInfo } from "../types";

const SOURCE_LABELS: Record<PluginSource, string> = {
  modrinth: "Modrinth",
  hangar: "Hangar (PaperMC)",
};

export function openPluginBrowser(serverId: string, onInstalled: () => void): () => void {
  const overlay = document.createElement("div");
  overlay.className = "file-editor-overlay";
  const panel = document.createElement("div");
  panel.className = "file-editor-panel";

  panel.innerHTML = `
    <div class="file-editor-header">
      <strong>Bővítmény keresése</strong>
      <div>
        <button class="btn" id="pb-close">Bezárás</button>
      </div>
    </div>
    <div class="file-editor-body" style="padding:1rem;overflow:auto;">
      <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.9rem;flex-wrap:wrap;">
        <select id="pb-source" style="max-width:180px;">
          <option value="modrinth">Modrinth</option>
          <option value="hangar">Hangar (PaperMC)</option>
        </select>
        <input id="pb-query" placeholder="pl. LuckPerms, WorldEdit, EssentialsX" style="flex:1;min-width:200px;" />
        <button class="btn btn-primary" id="pb-search">Keresés</button>
      </div>
      <p style="color:var(--text-dim);font-size:0.8rem;margin:0 0 0.9rem;">
        Csak hivatalos bővítmény-regiszterekből tölt le, ellenőrizetlen oldalakról soha.
      </p>
      <div id="pb-results"></div>
    </div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  panel.querySelector<HTMLButtonElement>("#pb-close")!.onclick = close;
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  const sourceSelect = panel.querySelector<HTMLSelectElement>("#pb-source")!;
  const queryInput = panel.querySelector<HTMLInputElement>("#pb-query")!;
  const resultsEl = panel.querySelector<HTMLDivElement>("#pb-results")!;

  async function runSearch() {
    const q = queryInput.value.trim();
    if (!q) return;
    const source = sourceSelect.value as PluginSource;
    resultsEl.innerHTML = `<div class="empty-state" style="padding:1rem;">Keresés…</div>`;
    try {
      const results = await api.searchPlugins(serverId, q, source);
      renderResults(results, source);
    } catch (err) {
      resultsEl.innerHTML = `<div class="empty-state" style="padding:1rem;">${escapeHtml(
        err instanceof ApiError ? err.message : "A keresés nem sikerült"
      )}</div>`;
    }
  }

  function renderResults(results: PluginSearchResult[], source: PluginSource) {
    if (results.length === 0) {
      resultsEl.innerHTML = `<div class="empty-state" style="padding:1rem;">Nincs találat a(z) ${escapeHtml(
        SOURCE_LABELS[source]
      )} regiszterben.</div>`;
      return;
    }
    // Everything interpolated below comes from a third-party registry, so it
    // is escaped rather than trusted like the dashboard's own data.
    resultsEl.innerHTML = results
      .map(
        (r) => `
      <div class="server-card" style="cursor:default;margin-bottom:0.6rem;" data-project="${escapeHtml(r.id)}">
        <div style="display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;">
          <div style="min-width:0;">
            <div class="server-name">${escapeHtml(r.name)}</div>
            <div class="server-meta">${escapeHtml(r.author)} · ${r.downloads.toLocaleString("hu-HU")} letöltés</div>
            <div style="color:var(--text-dim);font-size:0.82rem;margin-top:0.35rem;">${escapeHtml(
              r.description
            )}</div>
          </div>
          <div style="display:flex;gap:0.4rem;flex-shrink:0;">
            <a class="btn" href="${escapeHtml(r.pageUrl)}" target="_blank" rel="noopener noreferrer">Oldal</a>
            <button class="btn btn-primary" data-pick="${escapeHtml(r.id)}">Verziók</button>
          </div>
        </div>
        <div class="pb-versions" style="display:none;margin-top:0.7rem;padding-top:0.7rem;border-top:1px solid var(--border);"></div>
      </div>`
      )
      .join("");

    resultsEl.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach((btn) => {
      btn.onclick = () => void showVersions(btn, source);
    });
  }

  async function showVersions(btn: HTMLButtonElement, source: PluginSource) {
    const card = btn.closest(".server-card")!;
    const box = card.querySelector<HTMLDivElement>(".pb-versions")!;
    const projectId = btn.dataset.pick!;
    if (box.style.display !== "none") {
      box.style.display = "none";
      return;
    }
    box.style.display = "";
    box.innerHTML = `<div style="color:var(--text-dim);font-size:0.85rem;">Verziók betöltése…</div>`;
    try {
      const versions = await api.listPluginVersions(serverId, source, projectId);
      renderVersions(box, versions.slice(0, 12), source, projectId);
    } catch (err) {
      box.innerHTML = `<div style="color:var(--red);font-size:0.85rem;">${escapeHtml(
        err instanceof ApiError ? err.message : "A verziók betöltése nem sikerült"
      )}</div>`;
    }
  }

  function renderVersions(box: HTMLDivElement, versions: PluginVersionInfo[], source: PluginSource, projectId: string) {
    if (versions.length === 0) {
      box.innerHTML = `<div style="color:var(--text-dim);font-size:0.85rem;">Nincs elérhető verzió.</div>`;
      return;
    }
    box.innerHTML = versions
      .map((v) => {
        const games = v.gameVersions.slice(0, 6).join(", ");
        const loaders = v.loaders.join(", ");
        const installable = Boolean(v.downloadUrl);
        return `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.6rem;padding:0.35rem 0;">
          <div style="min-width:0;">
            <div style="font-size:0.88rem;">${escapeHtml(v.name)}${
              loaders ? ` <span style="color:var(--text-dim);font-size:0.76rem;">(${escapeHtml(loaders)})</span>` : ""
            }</div>
            <div style="color:var(--text-dim);font-size:0.78rem;">${escapeHtml(games)}${
              v.datePublished ? ` · ${new Date(v.datePublished).toLocaleDateString("hu-HU")}` : ""
            }</div>
          </div>
          ${
            installable
              ? `<button class="btn btn-primary" data-install="${escapeHtml(v.id)}">Telepítés</button>`
              : `<span style="color:var(--text-dim);font-size:0.78rem;">külső letöltés</span>`
          }
        </div>`;
      })
      .join("");

    box.querySelectorAll<HTMLButtonElement>("[data-install]").forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "Telepítés…";
        try {
          const plugin = await api.installPlugin(serverId, source, projectId, btn.dataset.install!);
          showToast(`Telepítve: ${plugin.filename}`);
          onInstalled();
          btn.textContent = "Telepítve";
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : "A telepítés nem sikerült", "error");
          btn.disabled = false;
          btn.textContent = "Telepítés";
        }
      };
    });
  }

  panel.querySelector<HTMLButtonElement>("#pb-search")!.onclick = () => void runSearch();
  queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void runSearch();
  });
  queryInput.focus();

  return close;
}
