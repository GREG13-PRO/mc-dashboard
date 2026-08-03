import { api, ApiError } from "../api";
import { escapeHtml } from "../lib/escape";
import { t } from "../lib/i18n";
import { confirmModal, promptModal } from "../components/Modal";
import { showToast } from "../components/Toast";
import type { AppPlatform, GithubSyncStatus, PublishedBuild } from "../types";

/**
 * Publishes the installable apps to the machines that use this dashboard.
 *
 * Hosted here rather than fetched from GitHub because this project's repository
 * is private: an unauthenticated request for its latest release gets a 404,
 * which is why the desktop app's update check never found anything and why a
 * phone could not have checked at all. Uploading a build once is what lets
 * every copy update itself.
 */

const SLOTS: { platform: AppPlatform; label: string; expects: string }[] = [
  { platform: "android", label: "Android", expects: "mc-dashboard-vX.Y.Z.apk" },
  {
    platform: "mac-arm64",
    label: "macOS (Apple Silicon)",
    expects: "Minecraft.Dashboard-X.Y.Z-arm64.dmg",
  },
  { platform: "mac-x64", label: "macOS (Intel)", expects: "Minecraft.Dashboard-X.Y.Z.dmg" },
  { platform: "windows", label: "Windows", expects: "Minecraft.Dashboard.Setup.X.Y.Z.exe" },
  { platform: "plugin", label: "Anti-cheat plugin", expects: "McDashGuard-vX.Y.Z.jar" },
];

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} kB`;
}

export function renderAppDistView(root: HTMLElement): () => void {
  let disposed = false;

  async function load() {
    if (disposed) return;
    let builds: PublishedBuild[];
    let github: GithubSyncStatus = {
      configured: false,
      watcher: { enabled: false, lastCheckedAt: null, lastResult: null, publishedVersion: null },
    };
    try {
      [builds, github] = await Promise.all([
        api.listPublishedBuilds(),
        api.githubStatus().catch(
          () =>
            ({
              configured: false,
              watcher: {
                enabled: false,
                lastCheckedAt: null,
                lastResult: null,
                publishedVersion: null,
              },
            }) as GithubSyncStatus
        ),
      ]);
    } catch (err) {
      root.innerHTML = `<div class="empty-state">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
      return;
    }
    if (disposed) return;

    const rows = SLOTS.map((slot) => {
      const build = builds.find((b) => b.platform === slot.platform);
      return `
        <div class="finding ${build ? "finding-info" : ""}">
          <div class="finding-head">
            <span class="finding-badge ${build ? "finding-info-badge" : ""}">${
              build ? `v${escapeHtml(build.version)}` : "—"
            }</span>
            <strong>${escapeHtml(slot.label)}</strong>
          </div>
          ${
            build
              ? `<p class="finding-detail">${escapeHtml(build.filename)} · ${sizeText(
                  build.sizeBytes
                )} · ${new Date(build.uploadedAt).toLocaleString()}</p>
                 <p class="finding-advice" style="word-break:break-all;">SHA-256: ${escapeHtml(
                   build.sha256
                 )}</p>
                 <div style="display:flex;gap:8px;margin-top:8px;">
                   <a class="btn" href="${escapeHtml(build.url)}">${t("letoltes")}</a>
                   <button class="btn btn-danger" data-delete="${escapeHtml(
                     build.filename
                   )}">${t("torles")}</button>
                 </div>`
              : `<p class="finding-advice">${t("varhato_fajlnev")}: ${escapeHtml(slot.expects)}</p>`
          }
        </div>`;
    }).join("");

    root.innerHTML = `
      <div class="server-view-header">
        <h2>${t("alkalmazasok")}</h2>
      </div>
      <div class="section" style="padding:16px;">
        <p class="finding-detail">${t("alkalmazasok_leiras")}</p>
        ${rows}
        <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;">
          <label class="btn btn-primary" for="build-file">${t("build_feltoltese")}</label>
          <input type="file" id="build-file" accept=".apk,.dmg,.exe" hidden />
          ${
            github.configured
              ? `<button class="btn" id="gh-sync">${t("behuzas_githubrol")}</button>
                 <button class="btn" id="gh-check">${t("ellenorzes_most")}</button>
                 <button class="btn" id="gh-clear">${t("token_torlese")}</button>`
              : `<button class="btn" id="gh-token">${t("github_token_beallitasa")}</button>`
          }
        </div>
        ${
          github.configured
            ? `<div class="field checkbox-row" style="margin-top:10px;">
                 <input type="checkbox" id="gh-watch" ${github.watcher.enabled ? "checked" : ""} />
                 <label for="gh-watch" style="margin:0">${t("automatikus_ellenorzes")}</label>
               </div>
               <p class="finding-advice" style="margin:0;">
                 ${t("automatikus_ellenorzes_leiras")}
                 ${
                   github.watcher.lastCheckedAt
                     ? `<br>${t("utolso_ellenorzes")}: ${new Date(
                         github.watcher.lastCheckedAt
                       ).toLocaleString()} — ${escapeHtml(github.watcher.lastResult ?? "")}`
                     : ""
                 }
               </p>`
            : ""
        }
        <p class="finding-advice" style="margin-top:8px;">
          ${
            github.error
              ? escapeHtml(github.error)
              : github.latest
                ? `${t("githubon_legfrissebb")}: ${escapeHtml(github.latest.tag)} (${
                    github.latest.assets.length
                  } ${t("build_db")})`
                : t("github_token_magyarazat")
          }
        </p>
      </div>
    `;

    const input = root.querySelector<HTMLInputElement>("#build-file")!;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const saved = await api.uploadBuild(file);
        showToast(`${t("feltoltve")}: ${saved.platform} v${saved.version}`);
        void load();
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("feltoltes_sikertelen"), "error");
      } finally {
        // Cleared so uploading the same file twice still fires a change event.
        input.value = "";
      }
    };

    root.querySelector<HTMLButtonElement>("#gh-token")?.addEventListener("click", async () => {
      const token = await promptModal(t("github_token"), t("github_token_hint"));
      if (!token) return;
      try {
        await api.setGithubToken(token);
        void load();
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("mentes_sikertelen"), "error");
      }
    });

    root.querySelector<HTMLInputElement>("#gh-watch")?.addEventListener("change", async (e) => {
      await api.setGithubWatch((e.target as HTMLInputElement).checked);
      void load();
    });

    const check = root.querySelector<HTMLButtonElement>("#gh-check");
    if (check) {
      check.onclick = async () => {
        check.disabled = true;
        check.textContent = t("ellenorzes_folyamatban");
        try {
          await api.checkGithubNow();
          void load();
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
          check.disabled = false;
          check.textContent = t("ellenorzes_most");
        }
      };
    }

    root.querySelector<HTMLButtonElement>("#gh-clear")?.addEventListener("click", async () => {
      await api.clearGithubToken();
      void load();
    });

    const sync = root.querySelector<HTMLButtonElement>("#gh-sync");
    if (sync) {
      sync.onclick = async () => {
        // Four installers is close to 300 MB over a home connection, so the
        // button has to say it is working or it reads as broken.
        sync.disabled = true;
        sync.textContent = t("behuzas_folyamatban");
        try {
          const saved = await api.syncFromGithub();
          showToast(`${t("behuzva")}: ${saved.length} build`);
          void load();
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("behuzas_sikertelen"), "error");
          sync.disabled = false;
          sync.textContent = t("behuzas_githubrol");
        }
      };
    }

    root.querySelectorAll<HTMLButtonElement>("[data-delete]").forEach((button) => {
      button.onclick = async () => {
        if (!(await confirmModal(t("biztosan_torlod_a_buildet")))) return;
        try {
          await api.deleteBuild(button.dataset.delete!);
          void load();
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("torles_sikertelen"), "error");
        }
      };
    });
  }

  void load();
  return () => {
    disposed = true;
  };
}
