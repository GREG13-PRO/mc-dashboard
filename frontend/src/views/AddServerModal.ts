import { api, ApiError } from "../api";
import { openModal } from "../components/Modal";
import { showToast } from "../components/Toast";
import type { ServerEntry, ServerEntryInput } from "../types";

export function openAddServerModal(onCreated: () => void, existing?: ServerEntry) {
  const form = document.createElement("div");
  form.innerHTML = `
    <h3>${existing ? "Szerver szerkesztése" : "Szerver hozzáadása"}</h3>
    <div class="field">
      <label for="f-name">Név</label>
      <input id="f-name" placeholder="pl. Survival, BungeeCord Proxy" value="${existing?.name ?? ""}" />
    </div>
    <div class="field">
      <label for="f-folder">Mappa (abszolút útvonal a szerveren)</label>
      <input id="f-folder" placeholder="/home/mc/servers/survival" value="${existing?.folder ?? ""}" />
    </div>
    <div class="field">
      <label for="f-start">Start script (a mappán belül)</label>
      <input id="f-start" placeholder="start.sh" value="${existing?.startScript ?? "start.sh"}" />
    </div>
    <div class="field">
      <label for="f-stop">Stop parancs (konzolba küldve)</label>
      <input id="f-stop" placeholder="stop" value="${existing?.stopCommand ?? "stop"}" />
    </div>
    <div class="field checkbox-row">
      <input id="f-rcon-enabled" type="checkbox" ${existing?.rcon.enabled ? "checked" : ""} />
      <label for="f-rcon-enabled" style="margin:0">RCON engedélyezve (játékoslistához)</label>
    </div>
    <div class="field">
      <label for="f-rcon-host">RCON host</label>
      <input id="f-rcon-host" value="${existing?.rcon.host ?? "127.0.0.1"}" />
    </div>
    <div class="field">
      <label for="f-rcon-port">RCON port</label>
      <input id="f-rcon-port" type="number" value="${existing?.rcon.port ?? 25575}" />
    </div>
    <div class="field">
      <label for="f-rcon-password">RCON jelszó ${existing ? "(üresen hagyva nem változik)" : ""}</label>
      <input id="f-rcon-password" type="password" />
    </div>
    <div id="form-error" class="error-text"></div>
    <div class="modal-actions">
      <button id="cancel-btn" class="btn">Mégse</button>
      <button id="save-btn" class="btn btn-primary">${existing ? "Mentés" : "Hozzáadás"}</button>
    </div>
  `;

  const close = openModal(form);
  form.querySelector<HTMLButtonElement>("#cancel-btn")!.onclick = () => close();

  form.querySelector<HTMLButtonElement>("#save-btn")!.onclick = async () => {
    const errorEl = form.querySelector<HTMLDivElement>("#form-error")!;
    errorEl.textContent = "";

    const name = form.querySelector<HTMLInputElement>("#f-name")!.value.trim();
    const folder = form.querySelector<HTMLInputElement>("#f-folder")!.value.trim();
    const startScript = form.querySelector<HTMLInputElement>("#f-start")!.value.trim();
    const stopCommand = form.querySelector<HTMLInputElement>("#f-stop")!.value.trim();
    const rconEnabled = form.querySelector<HTMLInputElement>("#f-rcon-enabled")!.checked;
    const rconHost = form.querySelector<HTMLInputElement>("#f-rcon-host")!.value.trim();
    const rconPort = Number(form.querySelector<HTMLInputElement>("#f-rcon-port")!.value);
    const rconPassword = form.querySelector<HTMLInputElement>("#f-rcon-password")!.value;

    if (!name || !folder || !startScript) {
      errorEl.textContent = "Név, mappa és start script megadása kötelező.";
      return;
    }

    const input: ServerEntryInput = {
      name,
      folder,
      startScript,
      stopCommand,
      rcon: {
        enabled: rconEnabled,
        host: rconHost,
        port: rconPort,
        // Left blank on edit -> backend keeps the previously stored password.
        password: rconPassword,
      },
    };

    try {
      if (existing) {
        await api.updateServer(existing.id, input);
        showToast("Szerver frissítve");
      } else {
        await api.createServer(input);
        showToast("Szerver hozzáadva");
      }
      close();
      onCreated();
    } catch (err) {
      errorEl.textContent = err instanceof ApiError ? err.message : "Ismeretlen hiba történt";
    }
  };
}
