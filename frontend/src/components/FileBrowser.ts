import { api, ApiError } from "../api";
import { openFileEditor } from "./FileEditor";
import { confirmModal } from "./Modal";
import { showToast } from "./Toast";
import type { FileEntryInfo } from "../types";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const ICONS: Record<FileEntryInfo["type"], string> = {
  directory: "📁",
  file: "📄",
  symlink: "🔗",
};

export class FileBrowser {
  private currentPath = "";

  constructor(
    private container: HTMLElement,
    private serverId: string
  ) {
    void this.render();
  }

  private async render() {
    this.container.innerHTML = `
      <div class="file-toolbar">
        <div class="breadcrumbs" id="breadcrumbs"></div>
        <button class="btn" id="mkdir-btn">+ Mappa</button>
        <label class="btn" style="display:inline-flex;align-items:center;">
          Feltöltés
          <input type="file" id="upload-input" style="display:none" />
        </label>
      </div>
      <table class="file-table">
        <thead><tr><th>Név</th><th>Méret</th><th>Módosítva</th><th></th></tr></thead>
        <tbody id="file-tbody"></tbody>
      </table>
    `;

    this.renderBreadcrumbs();

    this.container.querySelector<HTMLButtonElement>("#mkdir-btn")!.onclick = () => this.handleMkdir();
    this.container.querySelector<HTMLInputElement>("#upload-input")!.onchange = (e) =>
      this.handleUpload((e.target as HTMLInputElement).files?.[0]);

    try {
      const items = await api.listFiles(this.serverId, this.currentPath);
      this.renderItems(items);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Fájllista betöltése sikertelen", "error");
    }
  }

  private renderBreadcrumbs() {
    const el = this.container.querySelector<HTMLDivElement>("#breadcrumbs")!;
    const parts = this.currentPath.split("/").filter(Boolean);
    const crumbs = ["<span data-path=\"\">/</span>"];
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      crumbs.push(` / <span data-path="${acc}">${part}</span>`);
    }
    el.innerHTML = crumbs.join("");
    el.querySelectorAll<HTMLSpanElement>("span[data-path]").forEach((span) => {
      span.onclick = () => this.navigate(span.dataset.path ?? "");
    });
  }

  private navigate(path: string) {
    this.currentPath = path;
    void this.render();
  }

  private renderItems(items: FileEntryInfo[]) {
    const tbody = this.container.querySelector<HTMLTableSectionElement>("#file-tbody")!;
    const sorted = [...items].sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    tbody.innerHTML = sorted
      .map(
        (item) => `
      <tr class="file-row" data-name="${item.name}" data-type="${item.type}">
        <td><span class="file-icon">${ICONS[item.type]}</span>${item.name}</td>
        <td>${item.type === "directory" ? "" : formatSize(item.size)}</td>
        <td>${new Date(item.mtime).toLocaleString()}</td>
        <td>
          ${item.type !== "directory" ? `<button class="btn download-btn" data-name="${item.name}">↓</button>` : ""}
          <button class="btn btn-danger delete-btn" data-name="${item.name}">✕</button>
        </td>
      </tr>`
      )
      .join("");

    tbody.querySelectorAll<HTMLTableRowElement>("tr.file-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        const name = row.dataset.name!;
        const type = row.dataset.type as FileEntryInfo["type"];
        const path = this.currentPath ? `${this.currentPath}/${name}` : name;
        if (type === "directory") {
          this.navigate(path);
        } else {
          void this.openFile(path);
        }
      });
    });

    tbody.querySelectorAll<HTMLButtonElement>(".download-btn").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const path = this.currentPath ? `${this.currentPath}/${btn.dataset.name}` : btn.dataset.name!;
        window.open(api.downloadUrl(this.serverId, path), "_blank");
      };
    });

    tbody.querySelectorAll<HTMLButtonElement>(".delete-btn").forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const path = this.currentPath ? `${this.currentPath}/${btn.dataset.name}` : btn.dataset.name!;
        if (await confirmModal(`Biztosan törlöd: <strong>${btn.dataset.name}</strong>?`)) {
          try {
            await api.deleteFile(this.serverId, path);
            void this.render();
          } catch (err) {
            showToast(err instanceof ApiError ? err.message : "Törlés sikertelen", "error");
          }
        }
      };
    });
  }

  private async openFile(path: string) {
    try {
      const content = await api.readFile(this.serverId, path);
      openFileEditor(this.serverId, path, content);
    } catch (err) {
      if (err instanceof ApiError && err.status === 413) {
        showToast("A fájl túl nagy szerkesztéshez, letöltés indítva.", "error");
        window.open(api.downloadUrl(this.serverId, path), "_blank");
      } else {
        showToast(err instanceof ApiError ? err.message : "Fájl megnyitása sikertelen", "error");
      }
    }
  }

  private async handleMkdir() {
    const name = prompt("Új mappa neve:");
    if (!name) return;
    const path = this.currentPath ? `${this.currentPath}/${name}` : name;
    try {
      await api.mkdir(this.serverId, path);
      void this.render();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Mappa létrehozása sikertelen", "error");
    }
  }

  private async handleUpload(file: File | undefined) {
    if (!file) return;
    try {
      await api.uploadFile(this.serverId, this.currentPath, file);
      showToast("Feltöltve");
      void this.render();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Feltöltés sikertelen", "error");
    }
  }
}
