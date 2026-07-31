import { api, ApiError } from "../api";
import { openModal, confirmModal } from "../components/Modal";
import { showToast } from "../components/Toast";
import { getCurrentUser } from "../auth-state";
import type { ServerPermissions, ServerWithStatus, UserInput, UserPublic } from "../types";

const CAPABILITIES: { key: keyof ServerPermissions; label: string }[] = [
  { key: "console", label: "Konzol" },
  { key: "files", label: "Fájlok" },
  { key: "players", label: "Játékosok" },
  { key: "settings", label: "Beállítások" },
];

export function renderUsersView(root: HTMLElement): () => void {
  let disposed = false;
  let users: UserPublic[] = [];
  let servers: ServerWithStatus[] = [];

  root.innerHTML = `<div class="empty-state">Betöltés…</div>`;

  async function load() {
    try {
      [users, servers] = await Promise.all([api.listUsers(), api.listServers()]);
      if (disposed) return;
      render();
    } catch (err) {
      root.innerHTML = `<div class="empty-state">${
        err instanceof ApiError ? err.message : "Felhasználók betöltése sikertelen"
      }</div>`;
    }
  }

  function render() {
    root.innerHTML = `
      <div class="server-view-header">
        <h2>Felhasználók</h2>
        <div class="server-actions">
          <button class="btn btn-primary" id="add-user-btn">+ Új felhasználó</button>
        </div>
      </div>
      <div id="users-list"></div>
    `;

    root.querySelector<HTMLButtonElement>("#add-user-btn")!.onclick = () => openUserModal();

    const list = root.querySelector<HTMLDivElement>("#users-list")!;
    if (users.length === 0) {
      list.innerHTML = `<div class="empty-state" style="padding:1rem;">Még nincs más felhasználó.</div>`;
      return;
    }

    list.innerHTML = users
      .map((u) => {
        const grantedServers = servers.filter((s) => {
          const p = u.permissions[s.id];
          return p && (p.console || p.files || p.players || p.settings);
        });
        const summary = u.isAdmin
          ? "Teljes hozzáférés (admin)"
          : grantedServers.length === 0
            ? "Nincs hozzáférése egyetlen szerverhez sem"
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
            <button class="btn" data-edit="${u.id}">Szerkesztés</button>
            ${
              u.id !== getCurrentUser()?.id
                ? `<button class="btn btn-danger" data-delete="${u.id}">Törlés</button>`
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
            showToast("Felhasználó törölve");
            await load();
          } catch (err) {
            showToast(err instanceof ApiError ? err.message : "Törlés sikertelen", "error");
          }
        }
      };
    });
  }

  function openUserModal(existing?: UserPublic) {
    const form = document.createElement("div");
    form.innerHTML = `
      <h3>${existing ? "Felhasználó szerkesztése" : "Felhasználó hozzáadása"}</h3>
      <div class="field">
        <label for="u-username">Felhasználónév</label>
        <input id="u-username" value="${existing?.username ?? ""}" />
      </div>
      <div class="field">
        <label for="u-password">Jelszó ${existing ? "(üresen hagyva nem változik)" : ""}</label>
        <input id="u-password" type="password" />
      </div>
      <div class="field checkbox-row">
        <input id="u-admin" type="checkbox" ${existing?.isAdmin ? "checked" : ""} />
        <label for="u-admin" style="margin:0">Admin (teljes hozzáférés minden szerverhez, felhasználókezeléshez)</label>
      </div>
      <div id="perm-section">
        <p style="margin:0.8rem 0 0.4rem;color:var(--text-dim);font-size:0.85rem;">Per-szerver jogosultságok (adminnál figyelmen kívül marad)</p>
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
        <button id="cancel-btn" class="btn">Mégse</button>
        <button id="save-btn" class="btn btn-primary">${existing ? "Mentés" : "Hozzáadás"}</button>
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
        errorEl.textContent = "Felhasználónév megadása kötelező.";
        return;
      }
      if (!existing && !password) {
        errorEl.textContent = "Jelszó megadása kötelező új felhasználónál.";
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
          showToast("Felhasználó frissítve");
        } else {
          await api.createUser(input as UserInput);
          showToast("Felhasználó hozzáadva");
        }
        close();
        await load();
      } catch (err) {
        errorEl.textContent = err instanceof ApiError ? err.message : "Ismeretlen hiba történt";
      }
    };
  }

  void load();

  return () => {
    disposed = true;
  };
}
