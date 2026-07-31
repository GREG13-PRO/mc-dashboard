import { api, ApiError } from "../api";
import { t } from "../lib/i18n";
import { openModal, confirmModal } from "../components/Modal";
import { showToast } from "../components/Toast";
import { getCurrentUser } from "../auth-state";
import type { ServerPermissions, ServerWithStatus, UserInput, UserPublic } from "../types";

const CAPABILITIES: { key: keyof ServerPermissions; label: string }[] = [
  { key: "console", label: "Konzol" },
  { key: "files", label: t("fajlok") },
  { key: "players", label: t("jatekosok") },
  { key: "settings", label: t("beallitasok") },
];

export function renderUsersView(root: HTMLElement): () => void {
  let disposed = false;
  let users: UserPublic[] = [];
  let servers: ServerWithStatus[] = [];

  root.innerHTML = `<div class="empty-state">${t("betoltes")}</div>`;

  async function load() {
    try {
      [users, servers] = await Promise.all([api.listUsers(), api.listServers()]);
      if (disposed) return;
      render();
    } catch (err) {
      root.innerHTML = `<div class="empty-state">${
        err instanceof ApiError ? err.message : t("felhasznalok_betoltese_sikertelen")
      }</div>`;
    }
  }

  function render() {
    root.innerHTML = `
      <div class="server-view-header">
        <h2>${t("felhasznalok")}</h2>
        <div class="server-actions">
          <button class="btn btn-primary" id="add-user-btn">${t("uj_felhasznalo")}</button>
        </div>
      </div>
      <div id="users-list"></div>
    `;

    root.querySelector<HTMLButtonElement>("#add-user-btn")!.onclick = () => openUserModal();

    const list = root.querySelector<HTMLDivElement>("#users-list")!;
    if (users.length === 0) {
      list.innerHTML = `<div class="empty-state" style="padding:1rem;">${t("meg_nincs_mas_felhasznalo")}</div>`;
      return;
    }

    list.innerHTML = users
      .map((u) => {
        const grantedServers = servers.filter((s) => {
          const p = u.permissions[s.id];
          return p && (p.console || p.files || p.players || p.settings);
        });
        const summary = u.isAdmin
          ? t("teljes_hozzaferes_admin")
          : grantedServers.length === 0
            ? t("nincs_hozzaferese_egyetlen_szerverhez_sem")
            : grantedServers
                .map((s) => {
                  const p = u.permissions[s.id];
                  const caps = CAPABILITIES.filter((c) => p?.[c.key]).map((c) => c.label);
                  return `${s.name}: ${caps.join(", ")}`;
                })
                .join(" · ");

        return `
        <div class="server-card" data-id="${u.id}" style="cursor:default;">
          <div class="server-card-top">
            <span class="server-name">${u.username}${u.isAdmin ? " 👑" : ""}</span>
          </div>
          <div class="server-meta">${summary}</div>
          <div style="display:flex;gap:0.5rem;margin-top:0.6rem;">
            <button class="btn" data-edit="${u.id}">${t("szerkesztes")}</button>
            ${
              u.id !== getCurrentUser()?.id
                ? `<button class="btn btn-danger" data-delete="${u.id}">${t("torles")}</button>`
                : ""
            }
          </div>
        </div>`;
      })
      .join("");

    list.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((btn) => {
      btn.onclick = () => {
        const user = users.find((u) => u.id === btn.dataset.edit);
        if (user) openUserModal(user);
      };
    });
    list.querySelectorAll<HTMLButtonElement>("[data-delete]").forEach((btn) => {
      btn.onclick = async () => {
        const user = users.find((u) => u.id === btn.dataset.delete);
        if (!user) return;
        if (await confirmModal(`Biztosan törlöd a(z) <strong>${user.username}</strong> felhasználót?`)) {
          try {
            await api.deleteUser(user.id);
            showToast(t("felhasznalo_torolve"));
            await load();
          } catch (err) {
            showToast(err instanceof ApiError ? err.message : t("torles_sikertelen"), "error");
          }
        }
      };
    });
  }

  function openUserModal(existing?: UserPublic) {
    const form = document.createElement("div");
    form.innerHTML = `
      <h3>${existing ? t("felhasznalo_szerkesztese") : t("felhasznalo_hozzaadasa")}</h3>
      <div class="field">
        <label for="u-username">${t("felhasznalonev")}</label>
        <input id="u-username" value="${existing?.username ?? ""}" />
      </div>
      <div class="field">
        <label for="u-password">Jelszó ${existing ? t("uresen_hagyva_nem_valtozik") : ""}</label>
        <input id="u-password" type="password" />
      </div>
      <div class="field checkbox-row">
        <input id="u-admin" type="checkbox" ${existing?.isAdmin ? "checked" : ""} />
        <label for="u-admin" style="margin:0">${t("admin_teljes_hozzaferes_minden_szerverhez_felhas")}</label>
      </div>
      <div id="perm-section">
        <p style="margin:0.8rem 0 0.4rem;color:var(--text-dim);font-size:0.85rem;">${t("per_szerver_jogosultsagok_adminnal_figyelmen_kiv")}</p>
        ${servers
          .map(
            (s) => `
          <div style="margin-bottom:8px;padding:8px;border:0.5px solid var(--border);border-radius:var(--radius-md);">
            <div style="font-weight:600;margin-bottom:0.3rem;">${s.name}</div>
            <div style="display:flex;gap:1rem;flex-wrap:wrap;">
              ${CAPABILITIES.map(
                (c) => `
                <label style="display:flex;align-items:center;gap:0.3rem;font-weight:normal;">
                  <input type="checkbox" data-server="${s.id}" data-cap="${c.key}" ${
                    existing?.permissions[s.id]?.[c.key] ? "checked" : ""
                  } />
                  ${c.label}
                </label>`
              ).join("")}
            </div>
          </div>`
          )
          .join("")}
      </div>
      <div id="form-error" class="error-text"></div>
      <div class="modal-actions">
        <button id="cancel-btn" class="btn">${t("megse")}</button>
        <button id="save-btn" class="btn btn-primary">${existing ? t("mentes") : t("hozzaadas")}</button>
      </div>
    `;

    const close = openModal(form);
    const adminCheckbox = form.querySelector<HTMLInputElement>("#u-admin")!;
    const permSection = form.querySelector<HTMLDivElement>("#perm-section")!;
    const togglePermSection = () => {
      permSection.style.opacity = adminCheckbox.checked ? "0.4" : "1";
      permSection
        .querySelectorAll<HTMLInputElement>("input[type=checkbox]")
        .forEach((cb) => (cb.disabled = adminCheckbox.checked));
    };
    adminCheckbox.addEventListener("change", togglePermSection);
    togglePermSection();

    form.querySelector<HTMLButtonElement>("#cancel-btn")!.onclick = () => close();

    form.querySelector<HTMLButtonElement>("#save-btn")!.onclick = async () => {
      const errorEl = form.querySelector<HTMLDivElement>("#form-error")!;
      errorEl.textContent = "";

      const username = form.querySelector<HTMLInputElement>("#u-username")!.value.trim();
      const password = form.querySelector<HTMLInputElement>("#u-password")!.value;
      const isAdminChecked = adminCheckbox.checked;

      if (!username) {
        errorEl.textContent = t("felhasznalonev_megadasa_kotelezo");
        return;
      }
      if (!existing && !password) {
        errorEl.textContent = t("jelszo_megadasa_kotelezo_uj_felhasznalonal");
        return;
      }

      const permissions: Record<string, Partial<ServerPermissions>> = {};
      form.querySelectorAll<HTMLInputElement>("[data-server]").forEach((cb) => {
        const serverId = cb.dataset.server!;
        const cap = cb.dataset.cap as keyof ServerPermissions;
        permissions[serverId] = permissions[serverId] ?? {};
        permissions[serverId][cap] = cb.checked;
      });

      const input: UserInput & Partial<UserInput> = {
        username,
        isAdmin: isAdminChecked,
        permissions,
      };
      if (password) input.password = password;

      try {
        if (existing) {
          await api.updateUser(existing.id, input);
          showToast(t("felhasznalo_frissitve"));
        } else {
          await api.createUser(input as UserInput);
          showToast(t("felhasznalo_hozzaadva"));
        }
        close();
        await load();
      } catch (err) {
        errorEl.textContent = err instanceof ApiError ? err.message : t("ismeretlen_hiba_tortent");
      }
    };
  }

  void load();

  return () => {
    disposed = true;
  };
}
