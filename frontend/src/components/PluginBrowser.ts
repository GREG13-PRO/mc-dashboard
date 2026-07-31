import { api, ApiError } from "../api";
import { showToast } from "./Toast";
import { openModal } from "./Modal";
import { escapeHtml } from "../lib/escape";
import type { PluginSearchResult, PluginSource, PluginVersionInfo } from "../types";

const SOURCE_LABELS: Record<PluginSource, string> = {
  modrinth: "Modrinth",
  hangar: "Hangar (PaperMC)",
};

type SortKey = "relevance" | "downloads" | "name";

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".0", "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(".0", "")}k`;
  return String(n);
}

/** Newest game version a release targets, for the compatibility pill. */
function compatLabel(versions: PluginVersionInfo[]): string | null {
  const games = versions[0]?.gameVersions ?? [];
  return games.length > 0 ? games[games.length - 1] : null;
}

export function openPluginBrowser(serverId: string, onInstalled: () => void): () => void {
  const overlay = document.createElement("div");
  overlay.className = "file-editor-overlay";
  const panel = document.createElement("div");
  panel.className = "file-editor-panel";

  let results: PluginSearchResult[] = [];
  let source: PluginSource = "modrinth";
  // Relevance is what the registry ranked; re-sorting by downloads on a
  // keyword search buries the plugin actually being looked for.
  let sort: SortKey = "relevance";
  let category: string | null = null;
  // Cached per project so reopening a card does not re-hit the registry.
  const versionCache = new Map<string, PluginVersionInfo[]>();
  // Bumped on every search so badge lookups from a previous grid stop writing.
  let badgeToken = 0;

  panel.innerHTML = `
    <div class="file-editor-header">
      <strong>Bővítmény hozzáadása</strong>
      <div><button class="btn" id="pb-close">Bezárás</button></div>
    </div>
    <div class="file-editor-body" style="padding:16px;overflow:auto;">
      <div class="pb-toolbar">
        <select id="pb-source" style="max-width:170px;">
          <option value="modrinth">Modrinth</option>
          <option value="hangar">Hangar (PaperMC)</option>
        </select>
        <input class="pb-search" id="pb-query" placeholder="pl. LuckPerms, WorldEdit, EssentialsX" />
        <select id="pb-sort" style="max-width:150px;">
          <option value="relevance">Találati sorrend</option>
          <option value="downloads">Népszerűség</option>
          <option value="name">Név szerint</option>
        </select>
        <button class="btn btn-primary" id="pb-search-btn">Keresés</button>
      </div>
      <div class="pb-chips" id="pb-chips"></div>
      <div id="pb-results"></div>
      <p style="color:var(--text-dim);font-size:12px;margin-top:16px;">
        Csak hivatalos bővítmény-regiszterekből tölt le, ellenőrizetlen oldalakról soha.
      </p>
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
  const sortSelect = panel.querySelector<HTMLSelectElement>("#pb-sort")!;
  const queryInput = panel.querySelector<HTMLInputElement>("#pb-query")!;
  const chipsEl = panel.querySelector<HTMLDivElement>("#pb-chips")!;
  const resultsEl = panel.querySelector<HTMLDivElement>("#pb-results")!;

  async function runSearch() {
    const q = queryInput.value.trim();
    source = sourceSelect.value as PluginSource;
    resultsEl.innerHTML = `<div class="empty-state" style="padding:20px;">Keresés…</div>`;
    chipsEl.innerHTML = "";
    try {
      results = await api.searchPlugins(serverId, q, source);
      category = null;
      versionCache.clear();
      renderChips();
      renderGrid();
    } catch (err) {
      resultsEl.innerHTML = `<div class="empty-state" style="padding:20px;">${escapeHtml(
        err instanceof ApiError ? err.message : "A keresés nem sikerült"
      )}</div>`;
    }
  }

  function renderChips() {
    // Categories come from the results themselves rather than a fixed list, so
    // the chips always match what is actually on screen.
    const counts = new Map<string, number>();
    for (const r of results) {
      for (const c of r.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (top.length === 0) {
      chipsEl.innerHTML = "";
      return;
    }
    chipsEl.innerHTML = [
      `<div class="pb-chip ${category === null ? "active" : ""}" data-cat="">Összes</div>`,
      ...top.map(
        ([c, n]) =>
          `<div class="pb-chip ${category === c ? "active" : ""}" data-cat="${escapeHtml(c)}">${escapeHtml(
            c
          )} (${n})</div>`
      ),
    ].join("");

    chipsEl.querySelectorAll<HTMLDivElement>(".pb-chip").forEach((chip) => {
      chip.onclick = () => {
        category = chip.dataset.cat || null;
        renderChips();
        renderGrid();
      };
    });
  }

  function visibleResults(): PluginSearchResult[] {
    const filtered = category ? results.filter((r) => r.categories.includes(category!)) : results;
    if (sort === "relevance") return filtered;
    return [...filtered].sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name, "hu") : b.downloads - a.downloads
    );
  }

  function renderGrid() {
    const shown = visibleResults();
    if (shown.length === 0) {
      resultsEl.innerHTML = `<div class="empty-state" style="padding:20px;">Nincs találat a(z) ${escapeHtml(
        SOURCE_LABELS[source]
      )} regiszterben.</div>`;
      return;
    }

    // Everything below is third-party registry text, so it is escaped.
    resultsEl.innerHTML = `<div class="pb-grid">${shown
      .map(
        (r) => `
      <div class="pb-card" data-project="${escapeHtml(r.id)}">
        <div class="pb-icon">${
          r.iconUrl
            ? `<img src="${escapeHtml(r.iconUrl)}" alt="" loading="lazy" />`
            : `<span>${escapeHtml(r.name.charAt(0).toUpperCase())}</span>`
        }</div>
        <div class="pb-name">${escapeHtml(r.name)}</div>
        <div class="pb-desc">${escapeHtml(r.description)}</div>
        <div class="pb-meta">
          <span class="pb-downloads">↓ ${formatDownloads(r.downloads)}</span>
          <span class="pb-badge" data-compat="${escapeHtml(r.id)}">…</span>
        </div>
        <button class="btn btn-primary pb-add" data-add="${escapeHtml(r.id)}">Hozzáadás</button>
      </div>`
      )
      .join("")}</div>`;

    resultsEl.querySelectorAll<HTMLDivElement>(".pb-card").forEach((card) => {
      card.onclick = (e) => {
        // The install button lives inside the card; its click must not also
        // open the detail sheet.
        if ((e.target as HTMLElement).closest("button")) return;
        void openDetails(card.dataset.project!);
      };
    });

    resultsEl.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((btn) => {
      btn.onclick = () => void install(btn, btn.dataset.add!);
    });

    void fillCompatBadges(shown);
  }

  /**
   * Version lookups are one request per project, so they run after the grid is
   * already on screen rather than blocking it. Every card is filled, a few at a
   * time - doing only the first handful left the rest showing a placeholder
   * that never resolved.
   */
  async function fillCompatBadges(shown: PluginSearchResult[]) {
    const queue = [...shown];
    const token = ++badgeToken;

    const worker = async () => {
      while (queue.length > 0) {
        // A new search invalidates in-flight lookups for the old grid.
        if (token !== badgeToken) return;
        const r = queue.shift()!;
        const badge = resultsEl.querySelector<HTMLElement>(`[data-compat="${CSS.escape(r.id)}"]`);
        if (!badge) continue;
        try {
          const versions = versionCache.get(r.id) ?? (await api.listPluginVersions(serverId, source, r.id));
          versionCache.set(r.id, versions);
          if (token !== badgeToken) return;
          badge.textContent = compatLabel(versions) ?? "nincs build";
        } catch {
          badge.textContent = "—";
        }
      }
    };

    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  /** Unchanged install path: newest compatible version, same endpoint. */
  async function install(btn: HTMLButtonElement, projectId: string) {
    btn.classList.add("installing");
    btn.innerHTML = `<span class="pb-spinner"></span>`;
    try {
      const versions = versionCache.get(projectId) ?? (await api.listPluginVersions(serverId, source, projectId));
      versionCache.set(projectId, versions);
      const version = versions.find((v) => v.downloadUrl);
      if (!version) throw new ApiError(400, "Ehhez a szerverhez nincs telepíthető build.");
      const plugin = await api.installPlugin(serverId, source, projectId, version.id);
      showToast(`Telepítve: ${plugin.filename}`);
      onInstalled();
      btn.classList.remove("installing");
      btn.textContent = "✓ Telepítve";
      btn.disabled = true;
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "A telepítés nem sikerült", "error");
      btn.classList.remove("installing");
      btn.textContent = "Hozzáadás";
    }
  }

  async function openDetails(projectId: string) {
    const result = results.find((r) => r.id === projectId);
    const wrap = document.createElement("div");
    wrap.innerHTML = `<h3>${escapeHtml(result?.name ?? projectId)}</h3><p style="color:var(--text-dim);">Betöltés…</p>`;
    const closeModal = openModal(wrap);

    try {
      const [details, versions] = await Promise.all([
        api.getPluginDetails(serverId, source, projectId),
        versionCache.get(projectId)
          ? Promise.resolve(versionCache.get(projectId)!)
          : api.listPluginVersions(serverId, source, projectId),
      ]);
      versionCache.set(projectId, versions);

      wrap.innerHTML = `
        <h3>${escapeHtml(details.name)}</h3>
        <p style="color:var(--text-dim);font-size:12px;margin:0 0 16px;">${escapeHtml(details.description)}</p>
        ${
          details.gallery.length > 0
            ? `<div class="pb-gallery">${details.gallery
                .map((g) => `<img src="${escapeHtml(g)}" alt="" loading="lazy" />`)
                .join("")}</div>`
            : ""
        }
        ${details.body ? `<div class="pb-body">${escapeHtml(details.body)}</div>` : ""}
        <h4 style="margin:16px 0 8px;">Legutóbbi kiadások</h4>
        <div>${
          versions.length === 0
            ? `<div style="color:var(--text-dim);font-size:12px;">Nincs elérhető verzió.</div>`
            : versions
                .slice(0, 6)
                .map(
                  (v) => `
            <div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;font-size:12px;">
              <span>${escapeHtml(v.name)}</span>
              <span style="color:var(--text-dim);">${
                v.datePublished ? new Date(v.datePublished).toLocaleDateString("hu-HU") : ""
              }</span>
            </div>`
                )
                .join("")
        }</div>
        <div class="modal-actions">
          <a class="btn" href="${escapeHtml(details.pageUrl)}" target="_blank" rel="noopener noreferrer">Oldal</a>
          <button class="btn" id="pd-close">Bezárás</button>
          <button class="btn btn-primary" id="pd-install">Hozzáadás</button>
        </div>
      `;
      wrap.querySelector<HTMLButtonElement>("#pd-close")!.onclick = () => closeModal();
      wrap.querySelector<HTMLButtonElement>("#pd-install")!.onclick = (e) =>
        void install(e.currentTarget as HTMLButtonElement, projectId);
    } catch (err) {
      wrap.innerHTML = `<h3>${escapeHtml(result?.name ?? projectId)}</h3>
        <p class="error-text">${escapeHtml(
          err instanceof ApiError ? err.message : "A részletek betöltése nem sikerült"
        )}</p>
        <div class="modal-actions"><button class="btn" id="pd-close2">Bezárás</button></div>`;
      wrap.querySelector<HTMLButtonElement>("#pd-close2")!.onclick = () => closeModal();
    }
  }

  panel.querySelector<HTMLButtonElement>("#pb-search-btn")!.onclick = () => void runSearch();
  queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void runSearch();
  });
  sortSelect.onchange = () => {
    sort = sortSelect.value as SortKey;
    if (results.length > 0) renderGrid();
  };
  // Changing registry re-runs whatever is in the box, including nothing -
  // which is the "most popular" listing.
  sourceSelect.onchange = () => void runSearch();
  queryInput.focus();

  // Opens on the popular list rather than an empty panel.
  void runSearch();

  return close;
}
