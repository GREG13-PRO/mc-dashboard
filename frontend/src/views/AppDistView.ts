import { api, ApiError } from "../api";
import { escapeHtml } from "../lib/escape";
import { t } from "../lib/i18n";
import { confirmModal } from "../components/Modal";
import { showToast } from "../components/Toast";
import type { AndroidBuild } from "../types";

/**
 * Publishes the Android app to the phones that use this dashboard.
 *
 * The APK is hosted here rather than fetched from GitHub because this project's
 * repository is private: an unauthenticated request for its latest release gets
 * a 404, which is why the desktop app's update check has never found anything.
 * Uploading the file once is what lets every phone update itself.
 */
export function renderAppDistView(root: HTMLElement): () => void {
  let disposed = false;

  async function load() {
    if (disposed) return;
    let build: AndroidBuild | null;
    try {
      build = await api.getAndroidBuild();
    } catch (err) {
      root.innerHTML = `<div class="empty-state">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
      return;
    }
    if (disposed) return;

    root.innerHTML = `
      <div class="server-view-header">
        <h2>${t("android_app")}</h2>
      </div>
      <div class="section" style="padding:16px;">
        <p class="finding-detail">${t("android_app_leiras")}</p>
        ${
          build
            ? `<div class="finding finding-info">
                 <div class="finding-head">
                   <span class="finding-badge finding-info-badge">v${escapeHtml(build.version)}</span>
                   <strong>${escapeHtml(build.filename)}</strong>
                 </div>
                 <p class="finding-detail">${(build.sizeBytes / 1024).toFixed(0)} kB · ${new Date(
                   build.uploadedAt
                 ).toLocaleString()}</p>
                 <p class="finding-advice" style="word-break:break-all;">SHA-256: ${escapeHtml(
                   build.sha256
                 )}</p>
                 <div style="display:flex;gap:8px;margin-top:8px;">
                   <a class="btn" href="/api/app/android/download">${t("letoltes")}</a>
                   <button class="btn btn-danger" id="apk-delete">${t("torles")}</button>
                 </div>
               </div>`
            : `<div class="empty-state">${t("nincs_kozzetett_apk")}</div>`
        }
        <div style="margin-top:16px;">
          <label class="btn btn-primary" for="apk-file">${t("apk_feltoltese")}</label>
          <input type="file" id="apk-file" accept=".apk" hidden />
        </div>
      </div>
    `;

    const input = root.querySelector<HTMLInputElement>("#apk-file")!;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const saved = await api.uploadAndroidBuild(file);
        showToast(`${t("feltoltve")}: v${saved.version}`);
        void load();
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("feltoltes_sikertelen"), "error");
      } finally {
        input.value = "";
      }
    };

    root.querySelector<HTMLButtonElement>("#apk-delete")?.addEventListener("click", async () => {
      if (!(await confirmModal(t("biztosan_torlod_az_apkt")))) return;
      try {
        await api.deleteAndroidBuild();
        void load();
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("torles_sikertelen"), "error");
      }
    });
  }

  void load();
  return () => {
    disposed = true;
  };
}
