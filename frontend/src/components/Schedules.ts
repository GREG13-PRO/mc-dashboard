import { api, ApiError } from "../api";
import { escapeHtml } from "../lib/escape";
import { t } from "../lib/i18n";
import { icon } from "../lib/icons";
import { showToast } from "./Toast";
import { confirmModal, openModal } from "./Modal";
import type { Schedule, ScheduleAction } from "../types";

/**
 * Everything the dashboard can be told to do at a particular time.
 *
 * There used to be one such thing - restart at 04:00 - as a checkbox and a time
 * on the server's settings form. That covered the job somebody thought of
 * first, and the nightly backup, the snapshot before a busy weekend and the
 * five-minute warning had nowhere to live at all.
 */

const ACTION_LABEL: Record<ScheduleAction, string> = {
  restart: "utemezes_ujrainditas",
  start: "utemezes_inditas",
  stop: "utemezes_leallitas",
  backup: "utemezes_mentes",
  snapshot: "utemezes_pillanatkep",
  command: "utemezes_parancs",
};

const ACTION_ICON: Record<ScheduleAction, string> = {
  restart: "gauge",
  start: "chevronRight",
  stop: "shield",
  backup: "download",
  snapshot: "clipboard",
  command: "terminal",
};

/** Monday first, which is how the week reads here. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function dayLabel(day: number): string {
  return t(
    (["nap_v", "nap_h", "nap_k", "nap_sze", "nap_cs", "nap_p", "nap_szo"] as const)[day]
  );
}

function whenText(schedule: Schedule): string {
  if (schedule.kind === "interval") {
    const hours = schedule.intervalMinutes / 60;
    return hours >= 1 && Number.isInteger(hours)
      ? `${t("mindenketten")} ${hours} ${t("ora")}`
      : `${t("mindenketten")} ${schedule.intervalMinutes} ${t("perc")}`;
  }
  if (schedule.kind === "weekly") {
    const days = DAY_ORDER.filter((d) => schedule.days.includes(d)).map(dayLabel).join(", ");
    return `${days} · ${schedule.time}`;
  }
  return `${t("naponta")} ${schedule.time}`;
}

export function renderSchedules(root: HTMLElement, serverId: string): void {
  let schedules: Schedule[] = [];

  function openEditor(existing: Schedule | null) {
    const wrap = document.createElement("div");
    const draft: Partial<Schedule> = existing
      ? { ...existing }
      : {
          name: "",
          action: "restart",
          kind: "daily",
          time: "04:00",
          days: [],
          intervalMinutes: 360,
          warnMinutes: 0,
          warnMessage: "",
          command: "",
          enabled: true,
        };

    const draw = () => {
      wrap.innerHTML = `
        <h3>${existing ? t("utemezes_szerkesztese") : t("uj_utemezes")}</h3>
        <div class="field">
          <label for="sc-name">${t("nev")}</label>
          <input id="sc-name" value="${escapeHtml(draft.name ?? "")}" placeholder="${t("pl_napi_mentes")}" />
        </div>
        <div class="field">
          <label for="sc-action">${t("muvelet")}</label>
          <select id="sc-action">
            ${(Object.keys(ACTION_LABEL) as ScheduleAction[])
              .map(
                (action) =>
                  `<option value="${action}" ${draft.action === action ? "selected" : ""}>${t(
                    ACTION_LABEL[action] as Parameters<typeof t>[0]
                  )}</option>`
              )
              .join("")}
          </select>
        </div>
        ${
          draft.action === "command"
            ? `<div class="field">
                 <label for="sc-command">${t("parancs_cimke")}</label>
                 <input id="sc-command" value="${escapeHtml(draft.command ?? "")}" placeholder="say Szia!" />
               </div>`
            : ""
        }
        <div class="field">
          <label for="sc-kind">${t("gyakorisag")}</label>
          <select id="sc-kind">
            <option value="daily" ${draft.kind === "daily" ? "selected" : ""}>${t("naponta")}</option>
            <option value="weekly" ${draft.kind === "weekly" ? "selected" : ""}>${t("hetente")}</option>
            <option value="interval" ${draft.kind === "interval" ? "selected" : ""}>${t("idokozonkent")}</option>
          </select>
        </div>
        ${
          draft.kind === "interval"
            ? `<div class="field">
                 <label for="sc-interval">${t("percenkent")}</label>
                 <input id="sc-interval" type="number" min="10" max="10080" value="${draft.intervalMinutes}" />
               </div>`
            : `<div class="field">
                 <label for="sc-time">${t("idopont")}</label>
                 <input id="sc-time" type="time" value="${escapeHtml(draft.time ?? "04:00")}" />
               </div>`
        }
        ${
          draft.kind === "weekly"
            ? `<div class="field">
                 <label>${t("napok")}</label>
                 <div class="sc-days">
                   ${DAY_ORDER.map(
                     (day) => `
                     <button type="button" class="sc-day ${draft.days?.includes(day) ? "active" : ""}"
                             data-day="${day}">${dayLabel(day)}</button>`
                   ).join("")}
                 </div>
               </div>`
            : ""
        }
        ${
          draft.kind !== "interval"
            ? `<div class="field">
                 <label for="sc-warn">${t("figyelmeztetes_perccel_elotte")}</label>
                 <input id="sc-warn" type="number" min="0" max="60" value="${draft.warnMinutes}" />
               </div>
               ${
                 (draft.warnMinutes ?? 0) > 0
                   ? `<div class="field">
                        <label for="sc-warnmsg">${t("figyelmezteto_uzenet")}</label>
                        <input id="sc-warnmsg" value="${escapeHtml(draft.warnMessage ?? "")}"
                               placeholder="${t("pl_ujrainditas_5_perc")}" />
                      </div>`
                   : ""
               }`
            : ""
        }
        <div class="field checkbox-row">
          <input id="sc-enabled" type="checkbox" ${draft.enabled !== false ? "checked" : ""} />
          <label for="sc-enabled" style="margin:0">${t("bekapcsolva")}</label>
        </div>
        <div class="modal-actions">
          <button class="btn" id="sc-cancel">${t("megse")}</button>
          <button class="btn btn-primary" id="sc-save">${t("mentes")}</button>
        </div>`;

      // Read every field back before redrawing, or switching the frequency
      // would throw away the name somebody just typed.
      const collect = () => {
        draft.name = wrap.querySelector<HTMLInputElement>("#sc-name")!.value;
        draft.action = wrap.querySelector<HTMLSelectElement>("#sc-action")!.value as ScheduleAction;
        draft.kind = wrap.querySelector<HTMLSelectElement>("#sc-kind")!.value as Schedule["kind"];
        draft.command = wrap.querySelector<HTMLInputElement>("#sc-command")?.value ?? draft.command;
        draft.time = wrap.querySelector<HTMLInputElement>("#sc-time")?.value ?? draft.time;
        draft.intervalMinutes = Number(
          wrap.querySelector<HTMLInputElement>("#sc-interval")?.value ?? draft.intervalMinutes
        );
        draft.warnMinutes = Number(
          wrap.querySelector<HTMLInputElement>("#sc-warn")?.value ?? draft.warnMinutes
        );
        draft.warnMessage =
          wrap.querySelector<HTMLInputElement>("#sc-warnmsg")?.value ?? draft.warnMessage;
        draft.enabled = wrap.querySelector<HTMLInputElement>("#sc-enabled")!.checked;
      };

      for (const id of ["#sc-action", "#sc-kind", "#sc-warn"]) {
        wrap.querySelector<HTMLElement>(id)?.addEventListener("change", () => {
          collect();
          draw();
        });
      }

      wrap.querySelectorAll<HTMLButtonElement>("[data-day]").forEach((button) => {
        button.onclick = () => {
          collect();
          const day = Number(button.dataset.day);
          const days = new Set(draft.days ?? []);
          if (days.has(day)) days.delete(day);
          else days.add(day);
          draft.days = [...days];
          draw();
        };
      });

      wrap.querySelector<HTMLButtonElement>("#sc-cancel")!.onclick = () => close();
      wrap.querySelector<HTMLButtonElement>("#sc-save")!.onclick = async () => {
        collect();
        try {
          await api.saveSchedule(serverId, draft);
          close();
          void load();
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("mentes_sikertelen"), "error");
        }
      };
    };

    const close = openModal(wrap);
    draw();
  }

  function draw() {
    root.innerHTML = `
      <div class="prop-toolbar">
        <p class="finding-advice" style="flex:1;margin:0;">${t("utemezesek_leiras")}</p>
        <button class="btn btn-primary" id="sc-new">${t("uj_utemezes")}</button>
      </div>
      ${
        schedules.length === 0
          ? `<div class="empty-state">${t("nincs_utemezes")}</div>`
          : schedules
              .map(
                (schedule) => `
        <div class="sc-card ${schedule.enabled ? "" : "off"}">
          <span class="sc-icon">${icon(ACTION_ICON[schedule.action], 18)}</span>
          <div class="sc-body">
            <div class="sc-title">
              <strong>${escapeHtml(schedule.name)}</strong>
              ${schedule.enabled ? "" : `<span class="prop-badge prop-badge-quiet">${t("kikapcsolva")}</span>`}
            </div>
            <p class="sc-when">${t(ACTION_LABEL[schedule.action] as Parameters<typeof t>[0])} · ${escapeHtml(
              whenText(schedule)
            )}${
              schedule.warnMinutes > 0
                ? ` · ${schedule.warnMinutes} ${t("perccel_elotte_figyelmeztet")}`
                : ""
            }</p>
            ${
              schedule.lastRunAt
                ? `<p class="sc-last">${t("utolso_futas")}: ${new Date(
                    schedule.lastRunAt
                  ).toLocaleString()} — ${escapeHtml(schedule.lastResult ?? "")}</p>`
                : `<p class="sc-last">${t("meg_nem_futott")}</p>`
            }
          </div>
          <div class="sc-actions">
            <button class="btn" data-edit="${schedule.id}">${t("szerkesztes")}</button>
            <button class="btn btn-danger" data-delete="${schedule.id}">${t("torles")}</button>
          </div>
        </div>`
              )
              .join("")
      }
    `;

    root.querySelector<HTMLButtonElement>("#sc-new")!.onclick = () => openEditor(null);
    root.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((button) => {
      button.onclick = () => openEditor(schedules.find((s) => s.id === button.dataset.edit)!);
    });
    root.querySelectorAll<HTMLButtonElement>("[data-delete]").forEach((button) => {
      button.onclick = async () => {
        if (!(await confirmModal(t("biztosan_torlod_az_utemezest")))) return;
        try {
          await api.deleteSchedule(serverId, button.dataset.delete!);
          void load();
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("torles_sikertelen"), "error");
        }
      };
    });
  }

  async function load() {
    try {
      schedules = await api.listSchedules(serverId);
      draw();
    } catch (err) {
      root.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
    }
  }

  root.innerHTML = `<div class="empty-state" style="padding:16px;">${t("betoltes")}</div>`;
  void load();
}
