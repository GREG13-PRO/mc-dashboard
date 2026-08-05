import { api, ApiError } from "../api";
import { t } from "../lib/i18n";
import { openModal } from "../components/Modal";
import { showToast } from "../components/Toast";
import { escapeHtml } from "../lib/escape";
import type {
  InstallDefaults,
  ServerEntry,
  ServerEntryInput,
  ServerInstallSettings,
  ServerInstallType,
} from "../types";

/**
 * Two ways in.
 *
 * Simple asks three things - what kind of server, which version, what to call
 * it - and works the rest out: where to put it, a free port, RCON on with a
 * generated password, four gigabytes, vanilla game settings. Every one of the
 * other eleven fields has a right answer that somebody installing their first
 * server cannot be expected to know, and getting the port wrong is how you end
 * up with two servers fighting over 25565.
 *
 * Advanced is the form as it was, with those same answers pre-filled rather
 * than blank. Editing an existing server always uses it: by then every field
 * describes something real.
 */
export function openAddServerModal(onCreated: () => void, existing?: ServerEntry) {
  const form = document.createElement("div");
  // Simple only makes sense for a new install; there is nothing to simplify
  // about editing a server that already exists.
  let simple = !existing;

  form.innerHTML = `
    <h3>${existing ? t("szerver_szerkesztese") : t("szerver_hozzaadasa")}</h3>
    ${
      existing
        ? ""
        : `
    <div class="segmented" id="mode-seg" style="margin-bottom:14px;">
      <button type="button" class="segment active" data-mode="simple">${t("egyszeru_mod")}</button>
      <button type="button" class="segment" data-mode="advanced">${t("halado_mod")}</button>
    </div>
    <p class="finding-advice" id="mode-hint" style="margin:0 0 12px;">${t("egyszeru_mod_leiras")}</p>
    <div id="simple-summary" class="simple-summary"></div>`
    }
    ${
      existing
        ? ""
        : `
    <div class="field">
      <label for="f-install-type">${t("telepitesi_mod")}</label>
      <select id="f-install-type">
        <option value="manual">${t("meglevo_mappa_parancsfajl")}</option>
      </select>
    </div>
    <div class="field" id="install-version-field" style="display:none">
      <label for="f-install-version">${t("verzio")}</label>
      <select id="f-install-version"><option value="">${t("betoltes_dots")}</option></select>
    </div>
    <div id="install-settings" style="display:none">
      <div class="field">
        <label for="f-memory">${t("memoria")}</label>
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
          <label for="f-difficulty">${t("nehezseg")}</label>
          <select id="f-difficulty">
            <option value="peaceful">${t("bekes")}</option>
            <option value="easy">${t("konnyu")}</option>
            <option value="normal" selected>${t("normal")}</option>
            <option value="hard">${t("nehez")}</option>
          </select>
        </div>
        <div class="field">
          <label for="f-gamemode">${t("jatekmod")}</label>
          <select id="f-gamemode">
            <option value="survival" selected>Survival</option>
            <option value="creative">Creative</option>
            <option value="adventure">Adventure</option>
            <option value="spectator">Spectator</option>
          </select>
        </div>
        <div class="field">
          <label for="f-max-players">${t("max_jatekosszam")}</label>
          <input id="f-max-players" type="number" value="20" />
        </div>
      </div>
    </div>
    `
    }
    <div class="field">
      <label for="f-name">${t("nev")}</label>
      <input id="f-name" placeholder="pl. Survival, BungeeCord Proxy" value="${existing?.name ?? ""}" />
    </div>
    <div class="field">
      <label for="f-folder">${t("mappa_abszolut_utvonal_a_szerveren")}</label>
      <input id="f-folder" placeholder="/home/minecraft/Documents/Server/survival" value="${existing?.folder ?? ""}" />
    </div>
    <div class="field" id="start-script-field">
      <label for="f-start">${t("start_script_a_mappan_belul")}</label>
      <input id="f-start" placeholder="start.sh" value="${existing?.startScript ?? "start.sh"}" />
    </div>
    <div class="field" id="stop-command-field">
      <label for="f-stop">${t("stop_parancs_konzolba_kuldve")}</label>
      <input id="f-stop" placeholder="stop" value="${existing?.stopCommand ?? "stop"}" />
    </div>
    <div class="field checkbox-row">
      <input id="f-rcon-enabled" type="checkbox" ${existing?.rcon.enabled ? "checked" : ""} />
      <label for="f-rcon-enabled" style="margin:0">${t("rcon_engedelyezve_jatekoslistahoz")}</label>
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
      <label for="f-rcon-password">RCON jelszó ${existing ? t("uresen_hagyva_nem_valtozik") : ""}</label>
      <input id="f-rcon-password" type="password" />
    </div>
    <p class="finding-advice" style="margin:0 0 12px;">${t("utemezett_ujrainditas_athelyezve")}</p>
    <div class="field checkbox-row">
      <input id="f-crash-enabled" type="checkbox" ${existing?.crashRestart?.enabled ? "checked" : ""} />
      <label for="f-crash-enabled" style="margin:0">${t("automatikus_ujrainditas_osszeomlas_utan")}</label>
    </div>
    <div class="field">
      <label for="f-crash-attempts">${t("max_probalkozas_10_percen_belul")}</label>
      <input id="f-crash-attempts" type="number" min="1" max="20" value="${
        existing?.crashRestart?.maxAttempts ?? 3
      }" />
    </div>
    ${
      existing
        ? ""
        : `
    <div class="field checkbox-row eula-row" id="eula-row" style="display:none">
      <input type="checkbox" id="f-eula" />
      <label for="f-eula">${t("eula_elfogadas")}
        <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener noreferrer">${t(
          "eula_link"
        )}</a></label>
    </div>`
    }
    <div id="form-error" class="error-text"></div>
    <div class="modal-actions">
      <button id="cancel-btn" class="btn">${t("megse")}</button>
      <button id="save-btn" class="btn btn-primary">${existing ? t("mentes") : t("hozzaadas")}</button>
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
  const eulaRow = form.querySelector<HTMLDivElement>("#eula-row");
  const eulaBox = form.querySelector<HTMLInputElement>("#f-eula");

  /**
   * The EULA question, shown only when the answer matters.
   *
   * A proxy has no eula.txt and an existing folder already has whatever answer
   * its owner gave, so asking there would be a checkbox that does nothing -
   * which teaches people to tick without reading, and this is the one box in
   * the application where that matters.
   */
  function updateEulaRow() {
    if (!eulaRow) return;
    const type = installTypeSelect?.value ?? "manual";
    const needed = type !== "manual" && typeKinds.get(type) !== "proxy";
    eulaRow.style.display = needed ? "" : "none";
  }
  const mcSettings = form.querySelector<HTMLDivElement>("#install-mc-settings");
  const typeKinds = new Map<string, "server" | "proxy">();

  if (installTypeSelect) {
    api.listServerTypes().then((types) => {
      for (const option of types) {
        typeKinds.set(option.id, option.kind);
        const opt = document.createElement("option");
        opt.value = option.id;
        opt.textContent = option.label;
        installTypeSelect.appendChild(opt);
      }
      // Re-applied now the options exist. On the first pass the list was still
      // loading, so simple mode had nothing to switch to and sat on "manual" -
      // which is exactly the mode that shows a start script and a stop command.
      applyMode();
      updateEulaRow();
    });

    installTypeSelect.onchange = () => {
      const type = installTypeSelect.value;
      if (type === "manual") {
        installVersionField!.style.display = "none";
        installSettings!.style.display = "none";
        startScriptField.style.display = "";
        stopCommandField.style.display = "";
        updateEulaRow();
        return;
      }
      startScriptField.style.display = "none";
      stopCommandField.style.display = "none";
      installVersionField!.style.display = "";
      installSettings!.style.display = "";
      mcSettings!.style.display = typeKinds.get(type) === "proxy" ? "none" : "";
      updateEulaRow();
      installVersionSelect!.innerHTML = `<option value="">${t("verziok_betoltese")}</option>`;
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
          installVersionSelect!.innerHTML = `<option value="">${t("nem_sikerult_betolteni_a_verziokat")}</option>`;
        });
    };
  }


  /**
   * Fields that only mean something once you already know what they do.
   *
   * Hidden rather than removed, so the advanced form is the same form with the
   * same ids - the save path reads them either way and gets the suggested value
   * when simple mode never showed the field.
   */
  const ADVANCED_ONLY = [
    "#f-folder",
    "#f-rcon-enabled",
    "#f-rcon-host",
    "#f-rcon-port",
    "#f-rcon-password",
    "#f-crash-enabled",
    "#f-crash-attempts",
    "#f-port",
    "#f-motd",
    "#f-difficulty",
    "#f-gamemode",
    "#f-max-players",
  ];

  let defaults: InstallDefaults | null = null;
  let defaultsFor = "";

  const modeSeg = form.querySelector<HTMLElement>("#mode-seg");
  const summary = form.querySelector<HTMLElement>("#simple-summary");
  const modeHint = form.querySelector<HTMLElement>("#mode-hint");
  const nameInput = form.querySelector<HTMLInputElement>("#f-name")!;
  const folderInput = form.querySelector<HTMLInputElement>("#f-folder")!;

  function applyMode() {
    for (const selector of ADVANCED_ONLY) {
      const field = form.querySelector<HTMLElement>(selector)?.closest<HTMLElement>(".field");
      if (field) field.style.display = simple ? "none" : "";
    }
    // The scheduled-restart note is advice about the advanced form.
    form.querySelectorAll<HTMLElement>(".finding-advice").forEach((el) => {
      if (el.id !== "mode-hint") el.style.display = simple ? "none" : "";
    });
    if (summary) summary.style.display = simple ? "" : "none";
    if (modeHint) modeHint.textContent = simple ? t("egyszeru_mod_leiras") : t("halado_mod_leiras");
    modeSeg?.querySelectorAll<HTMLElement>(".segment").forEach((btn) => {
      btn.classList.toggle("active", (btn.dataset.mode === "simple") === simple);
    });
    // Manual adoption of an existing folder is the definition of advanced, so
    // simple mode neither offers it nor can be left sitting on it.
    if (installTypeSelect) {
      const manual = installTypeSelect.querySelector<HTMLOptionElement>('option[value="manual"]');
      if (manual) manual.hidden = simple;
      if (simple && installTypeSelect.value === "manual") {
        installTypeSelect.value = installTypeSelect.options[1]?.value ?? "manual";
        installTypeSelect.onchange?.(new Event("change"));
      }
    }
    renderSummary();
  }

  function renderSummary() {
    if (!summary || !simple) return;
    if (!defaults) {
      summary.innerHTML = `<p class="ov-note">${t("adj_nevet_a_szervernek")}</p>`;
      return;
    }
    summary.innerHTML = `
      <div class="ov-row"><span>${t("mappa")}</span><strong>${escapeHtml(defaults.folder)}</strong></div>
      <div class="ov-row"><span>${t("port")}</span><strong>${defaults.port}</strong></div>
      <div class="ov-row"><span>RCON</span><strong>${t("bekapcsolva")} (${defaults.rconPort})</strong></div>
      <p class="ov-note">${t("barmikor_modosithato")}</p>`;
  }

  /**
   * Asks the server what to use, once the name has settled.
   *
   * Server-side because the browser cannot know which ports are free on that
   * machine or where the other servers live - and those are exactly the two
   * things a beginner would get wrong.
   */
  let defaultsTimer: ReturnType<typeof setTimeout> | null = null;
  async function refreshDefaults() {
    const name = nameInput.value.trim();
    if (!name || name === defaultsFor) return;
    try {
      defaults = await api.installDefaults(name);
      defaultsFor = name;
      // The advanced form is pre-filled from the same suggestion, so switching
      // across does not present an empty folder box.
      if (!folderInput.value.trim() || folderInput.dataset.suggested === "1") {
        folderInput.value = defaults.folder;
        folderInput.dataset.suggested = "1";
      }
      renderSummary();
    } catch {
      // Leave the previous suggestion in place; the save path falls back to
      // whatever is in the folder field.
    }
  }

  if (!existing) {
    nameInput.addEventListener("input", () => {
      if (defaultsTimer) clearTimeout(defaultsTimer);
      defaultsTimer = setTimeout(() => void refreshDefaults(), 400);
    });
    folderInput.addEventListener("input", () => {
      // Once it is typed in by hand it stops being a suggestion.
      folderInput.dataset.suggested = "0";
    });
    modeSeg?.querySelectorAll<HTMLButtonElement>(".segment").forEach((btn) => {
      btn.onclick = () => {
        simple = btn.dataset.mode === "simple";
        applyMode();
      };
    });
    applyMode();
  }

  form.querySelector<HTMLButtonElement>("#save-btn")!.onclick = async () => {
    const errorEl = form.querySelector<HTMLDivElement>("#form-error")!;
    errorEl.textContent = "";

    const name = form.querySelector<HTMLInputElement>("#f-name")!.value.trim();
    // In simple mode the name is the only thing typed, so the suggestion has to
    // be current before it is used - the debounce may not have fired yet.
    if (simple && !existing) await refreshDefaults();
    const folder = simple && defaults ? defaults.folder : form.querySelector<HTMLInputElement>("#f-folder")!.value.trim();
    const installType = installTypeSelect?.value ?? "manual";

    if (installType !== "manual") {
      const version = installVersionSelect?.value ?? "";
      if (!name || !folder) {
        errorEl.textContent = t("nev_es_mappa_megadasa_kotelezo");
        return;
      }
      if (!version) {
        errorEl.textContent = t("valassz_verziot");
        return;
      }

      const settings: ServerInstallSettings = {
        memoryMb: Number(form.querySelector<HTMLSelectElement>("#f-memory")!.value),
      };
      const isProxy = typeKinds.get(installType) === "proxy";
      if (!isProxy) {
        // Simple mode never showed these, so it uses the free port the server
        // picked, the server's own name as the MOTD, and vanilla's defaults for
        // the rest. All of it is editable afterwards on the settings tabs.
        settings.port = simple && defaults
          ? defaults.port
          : Number(form.querySelector<HTMLInputElement>("#f-port")!.value);
        settings.motd = simple
          ? name
          : form.querySelector<HTMLInputElement>("#f-motd")!.value.trim();
        settings.difficulty = simple
          ? "normal"
          : form.querySelector<HTMLSelectElement>("#f-difficulty")!.value;
        settings.gamemode = simple
          ? "survival"
          : form.querySelector<HTMLSelectElement>("#f-gamemode")!.value;
        settings.maxPlayers = simple
          ? 20
          : Number(form.querySelector<HTMLInputElement>("#f-max-players")!.value);
      }

      // RCON on by default in simple mode: the player list, the map's player
      // markers and the game rules screen all need it, and it is not something
      // a first-time user knows to look for. The password is the generated one,
      // never typed.
      const rcon =
        !isProxy && simple && defaults
          ? { enabled: true, port: defaults.rconPort, password: defaults.rconPassword }
          : undefined;

      // Checked here rather than by disabling the button: a button that is dead
      // for a reason you cannot see is worse than one that tells you why.
      if (!isProxy && !eulaBox?.checked) {
        errorEl.textContent = t("eula_kotelezo");
        eulaBox?.focus();
        return;
      }

      const saveBtn = form.querySelector<HTMLButtonElement>("#save-btn")!;
      const originalLabel = saveBtn.textContent;
      saveBtn.disabled = true;
      // Forge/NeoForge/Quilt run a real installer that pulls dependencies, so
      // this can legitimately take a couple of minutes.
      saveBtn.textContent = t("telepites_eltarthat_par_percig");
      try {
        await api.installServer({
          name,
          folder,
          type: installType as ServerInstallType,
          version,
          settings,
          rcon,
          acceptEula: eulaBox?.checked === true,
        });
        showToast(t("szerver_telepitve"));
        close();
        onCreated();
      } catch (err) {
        errorEl.textContent = err instanceof ApiError ? err.message : t("ismeretlen_hiba_tortent");
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
    const crashEnabled = form.querySelector<HTMLInputElement>("#f-crash-enabled")!.checked;
    const crashAttempts = Number(form.querySelector<HTMLInputElement>("#f-crash-attempts")!.value);

    if (!name || !folder || !startScript) {
      errorEl.textContent = t("nev_mappa_es_start_script_megadasa_kotelezo");
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
      crashRestart: {
        enabled: crashEnabled,
        maxAttempts: crashAttempts || 3,
      },
    };

    try {
      if (existing) {
        await api.updateServer(existing.id, input);
        showToast(t("szerver_frissitve"));
      } else {
        await api.createServer(input);
        showToast(t("szerver_hozzaadva"));
      }
      close();
      onCreated();
    } catch (err) {
      errorEl.textContent = err instanceof ApiError ? err.message : t("ismeretlen_hiba_tortent");
    }
  };
}
