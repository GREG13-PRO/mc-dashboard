import { api, ApiError } from "../api";
import { openModal } from "../components/Modal";
import { showToast } from "../components/Toast";
import type { ServerEntry, ServerEntryInput, ServerInstallSettings, ServerInstallType } from "../types";

export function openAddServerModal(onCreated: () => void, existing?: ServerEntry) {
  const form = document.createElement("div");
  form.innerHTML = `
    <h3>${existing ? "Szerver szerkesztése" : "Szerver hozzáadása"}</h3>
    ${
      existing
        ? ""
        : `
    <div class="field">
      <label for="f-install-type">Telepítési mód</label>
      <select id="f-install-type">
        <option value="manual">Meglévő mappa/parancsfájl megadása</option>
      </select>
    </div>
    <div class="field" id="install-version-field" style="display:none">
      <label for="f-install-version">Verzió</label>
      <select id="f-install-version"><option value="">Betöltés...</option></select>
    </div>
    <div id="install-settings" style="display:none">
      <div class="field">
        <label for="f-memory">Memória</label>
        <select id="f-memory">
          <option value="1024">1 GB</option>
          <option value="2048">2 GB</option>
          <option value="4096" selected>4 GB</option>
          <option value="6144">6 GB</option>
          <option value="8192">8 GB</option>
        </select>
      </div>
      <div id="install-mc-settings">
        <div class="field">
          <label for="f-port">Port</label>
          <input id="f-port" type="number" value="25565" />
        </div>
        <div class="field">
          <label for="f-motd">MOTD (a szerverlistában megjelenő szöveg)</label>
          <input id="f-motd" placeholder="Egy Minecraft szerver" />
        </div>
        <div class="field">
          <label for="f-difficulty">Nehézség</label>
          <select id="f-difficulty">
            <option value="peaceful">Békés</option>
            <option value="easy">Könnyű</option>
            <option value="normal" selected>Normál</option>
            <option value="hard">Nehéz</option>
          </select>
        </div>
        <div class="field">
          <label for="f-gamemode">Játékmód</label>
          <select id="f-gamemode">
            <option value="survival" selected>Survival</option>
            <option value="creative">Creative</option>
            <option value="adventure">Adventure</option>
            <option value="spectator">Spectator</option>
          </select>
        </div>
        <div class="field">
          <label for="f-max-players">Max játékosszám</label>
          <input id="f-max-players" type="number" value="20" />
        </div>
      </div>
    </div>
    `
    }
    <div class="field">
      <label for="f-name">Név</label>
      <input id="f-name" placeholder="pl. Survival, BungeeCord Proxy" value="${existing?.name ?? ""}" />
    </div>
    <div class="field">
      <label for="f-folder">Mappa (abszolút útvonal a szerveren)</label>
      <input id="f-folder" placeholder="/home/minecraft/Documents/Server/survival" value="${existing?.folder ?? ""}" />
    </div>
    <div class="field" id="start-script-field">
      <label for="f-start">Start script (a mappán belül)</label>
      <input id="f-start" placeholder="start.sh" value="${existing?.startScript ?? "start.sh"}" />
    </div>
    <div class="field" id="stop-command-field">
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
    <div class="field checkbox-row">
      <input id="f-restart-enabled" type="checkbox" ${existing?.scheduledRestart.enabled ? "checked" : ""} />
      <label for="f-restart-enabled" style="margin:0">Ütemezett napi újraindítás</label>
    </div>
    <div class="field">
      <label for="f-restart-time">Időpont (ha fut a szerver akkor)</label>
      <input id="f-restart-time" type="time" value="${existing?.scheduledRestart.time ?? "04:00"}" />
    </div>
    <div id="form-error" class="error-text"></div>
    <div class="modal-actions">
      <button id="cancel-btn" class="btn">Mégse</button>
      <button id="save-btn" class="btn btn-primary">${existing ? "Mentés" : "Hozzáadás"}</button>
    </div>
  `;

  const close = openModal(form);
  form.querySelector<HTMLButtonElement>("#cancel-btn")!.onclick = () => close();

  const installTypeSelect = form.querySelector<HTMLSelectElement>("#f-install-type");
  const installVersionField = form.querySelector<HTMLDivElement>("#install-version-field");
  const installVersionSelect = form.querySelector<HTMLSelectElement>("#f-install-version");
  const startScriptField = form.querySelector<HTMLDivElement>("#start-script-field")!;
  const stopCommandField = form.querySelector<HTMLDivElement>("#stop-command-field")!;

  const installSettings = form.querySelector<HTMLDivElement>("#install-settings");
  const mcSettings = form.querySelector<HTMLDivElement>("#install-mc-settings");
  const typeKinds = new Map<string, "server" | "proxy">();

  if (installTypeSelect) {
    api.listServerTypes().then((types) => {
      for (const t of types) {
        typeKinds.set(t.id, t.kind);
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = t.label;
        installTypeSelect.appendChild(opt);
      }
    });

    installTypeSelect.onchange = () => {
      const type = installTypeSelect.value;
      if (type === "manual") {
        installVersionField!.style.display = "none";
        installSettings!.style.display = "none";
        startScriptField.style.display = "";
        stopCommandField.style.display = "";
        return;
      }
      startScriptField.style.display = "none";
      stopCommandField.style.display = "none";
      installVersionField!.style.display = "";
      installSettings!.style.display = "";
      mcSettings!.style.display = typeKinds.get(type) === "proxy" ? "none" : "";
      installVersionSelect!.innerHTML = `<option value="">Verziók betöltése...</option>`;
      api
        .listServerVersions(type as ServerInstallType)
        .then((versions) => {
          installVersionSelect!.innerHTML = "";
          for (const v of versions) {
            const opt = document.createElement("option");
            opt.value = v;
            opt.textContent = v;
            installVersionSelect!.appendChild(opt);
          }
        })
        .catch(() => {
          installVersionSelect!.innerHTML = `<option value="">Nem sikerült betölteni a verziókat</option>`;
        });
    };
  }

  form.querySelector<HTMLButtonElement>("#save-btn")!.onclick = async () => {
    const errorEl = form.querySelector<HTMLDivElement>("#form-error")!;
    errorEl.textContent = "";

    const name = form.querySelector<HTMLInputElement>("#f-name")!.value.trim();
    const folder = form.querySelector<HTMLInputElement>("#f-folder")!.value.trim();
    const installType = installTypeSelect?.value ?? "manual";

    if (installType !== "manual") {
      const version = installVersionSelect?.value ?? "";
      if (!name || !folder) {
        errorEl.textContent = "Név és mappa megadása kötelező.";
        return;
      }
      if (!version) {
        errorEl.textContent = "Válassz verziót.";
        return;
      }

      const settings: ServerInstallSettings = {
        memoryMb: Number(form.querySelector<HTMLSelectElement>("#f-memory")!.value),
      };
      if (typeKinds.get(installType) !== "proxy") {
        settings.port = Number(form.querySelector<HTMLInputElement>("#f-port")!.value);
        settings.motd = form.querySelector<HTMLInputElement>("#f-motd")!.value.trim();
        settings.difficulty = form.querySelector<HTMLSelectElement>("#f-difficulty")!.value;
        settings.gamemode = form.querySelector<HTMLSelectElement>("#f-gamemode")!.value;
        settings.maxPlayers = Number(form.querySelector<HTMLInputElement>("#f-max-players")!.value);
      }

      const saveBtn = form.querySelector<HTMLButtonElement>("#save-btn")!;
      const originalLabel = saveBtn.textContent;
      saveBtn.disabled = true;
      // Forge/NeoForge/Quilt run a real installer that pulls dependencies, so
      // this can legitimately take a couple of minutes.
      saveBtn.textContent = "Telepítés… (eltarthat pár percig)";
      try {
        await api.installServer({ name, folder, type: installType as ServerInstallType, version, settings });
        showToast("Szerver telepítve");
        close();
        onCreated();
      } catch (err) {
        errorEl.textContent = err instanceof ApiError ? err.message : "Ismeretlen hiba történt";
        saveBtn.disabled = false;
        saveBtn.textContent = originalLabel;
      }
      return;
    }

    const startScript = form.querySelector<HTMLInputElement>("#f-start")!.value.trim();
    const stopCommand = form.querySelector<HTMLInputElement>("#f-stop")!.value.trim();
    const rconEnabled = form.querySelector<HTMLInputElement>("#f-rcon-enabled")!.checked;
    const rconHost = form.querySelector<HTMLInputElement>("#f-rcon-host")!.value.trim();
    const rconPort = Number(form.querySelector<HTMLInputElement>("#f-rcon-port")!.value);
    const rconPassword = form.querySelector<HTMLInputElement>("#f-rcon-password")!.value;
    const restartEnabled = form.querySelector<HTMLInputElement>("#f-restart-enabled")!.checked;
    const restartTime = form.querySelector<HTMLInputElement>("#f-restart-time")!.value;

    if (!name || !folder || !startScript) {
      errorEl.textContent = "Név, mappa és start script megadása kötelező.";
      return;
    }
    if (restartEnabled && !restartTime) {
      errorEl.textContent = "Add meg az ütemezett újraindítás időpontját.";
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
      scheduledRestart: {
        enabled: restartEnabled,
        time: restartTime || "04:00",
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
