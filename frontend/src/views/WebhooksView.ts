import { api, ApiError } from "../api";
import { escapeHtml } from "../lib/escape";
import { t } from "../lib/i18n";
import { confirmModal } from "../components/Modal";
import { showToast } from "../components/Toast";
import type { WebhooksResponse } from "../types";
import { pageHead } from "../components/PageHead";

/**
 * Outgoing webhooks and how they are being received.
 *
 * The delivery side is half the screen on purpose. Every service worth posting
 * to rate-limits, and the way that goes wrong is silent - posts start coming
 * back 429 and nobody notices the alerts stopped until the day one mattered.
 */
export function renderWebhooksView(root: HTMLElement): () => void {
  let disposed = false;

  async function load() {
    if (disposed) return;
    let data: WebhooksResponse;
    try {
      data = await api.listWebhooks();
    } catch (err) {
      root.innerHTML = `<div class="empty-state">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
      return;
    }
    if (disposed) return;

    const limitFor = (id: string) => data.rateLimits.find((r) => r.webhookId === id);

    root.innerHTML = `
      ${pageHead({ icon: "bell", title: t("webhookok"), description: t("hub_webhookok") })}
      <div class="section" style="padding:16px;">
        <p class="finding-advice" style="margin:0 0 12px;">${t("webhookok_leiras")}</p>

        ${
          data.webhooks.length === 0
            ? `<div class="empty-state">${t("nincs_webhook")}</div>`
            : data.webhooks
                .map((hook) => {
                  const limit = limitFor(hook.id);
                  const throttled = (limit?.throttled ?? 0) > 0;
                  return `
                <div class="finding ${throttled ? "finding-warning" : hook.enabled ? "finding-info" : ""}">
                  <div class="finding-head">
                    <span class="finding-badge">${hook.format}</span>
                    <strong>${escapeHtml(hook.name)}</strong>
                  </div>
                  <p class="finding-detail" style="word-break:break-all;">${escapeHtml(
                    hook.url.replace(/\/[^/]{8,}$/, "/…")
                  )}</p>
                  <p class="finding-detail">${
                    hook.events.map((e) => escapeHtml(e)).join(", ") || t("nincs_esemeny")
                  }</p>
                  ${
                    limit
                      ? `<p class="finding-advice">
                           ${t("kuldesek")}: ${limit.attempts} ·
                           ${t("hibas")}: ${limit.failures} ·
                           ${t("korlatozva_429")}: ${limit.throttled}
                           ${
                             limit.lastRemaining
                               ? ` · ${t("maradek_keret")}: ${escapeHtml(limit.lastRemaining)}`
                               : ""
                           }
                           ${
                             limit.lastResetSeconds
                               ? ` · ${t("ujra")}: ${escapeHtml(limit.lastResetSeconds)}s`
                               : ""
                           }
                           ${limit.medianMs !== null ? ` · ${limit.medianMs} ms` : ""}
                         </p>`
                      : `<p class="finding-advice">${t("meg_nem_kuldott")}</p>`
                  }
                  <div style="display:flex;gap:8px;margin-top:8px;">
                    <button class="btn" data-test="${escapeHtml(hook.id)}">${t("teszt")}</button>
                    <button class="btn btn-danger" data-del="${escapeHtml(hook.id)}">${t(
                      "torles"
                    )}</button>
                  </div>
                </div>`;
                })
                .join("")
        }

        <h3 style="margin:20px 0 8px;font-size:13px;">${t("uj_webhook")}</h3>
        <div class="field">
          <label for="wh-name">${t("nev")}</label>
          <input id="wh-name" type="text" placeholder="Discord" />
        </div>
        <div class="field">
          <label for="wh-url">URL</label>
          <input id="wh-url" type="text" placeholder="https://discord.com/api/webhooks/..." />
        </div>
        <div class="field">
          <label for="wh-format">${t("formatum")}</label>
          <select id="wh-format">
            <option value="discord">Discord</option>
            <option value="json">${t("nyers_json")}</option>
          </select>
        </div>
        <div class="field">
          <label>${t("esemenyek")}</label>
          <div style="display:flex;flex-wrap:wrap;gap:10px;">
            ${data.events
              .map(
                (event) =>
                  `<label style="font-size:12px;display:flex;align-items:center;gap:4px;">
                     <input type="checkbox" class="wh-event" value="${escapeHtml(event)}" checked />
                     ${escapeHtml(event)}
                   </label>`
              )
              .join("")}
          </div>
        </div>
        <button class="btn btn-primary" id="wh-add">${t("hozzaadas")}</button>

        <h3 style="margin:24px 0 8px;font-size:13px;">${t("kuldesi_naplo")}</h3>
        ${
          data.deliveries.length === 0
            ? `<div class="empty-state">${t("meg_nincs_kuldes")}</div>`
            : `<table class="file-table">
                 <thead><tr>
                   <th>${t("idopont")}</th><th>${t("esemeny")}</th>
                   <th>${t("valasz")}</th><th>ms</th>
                 </tr></thead>
                 <tbody>
                   ${data.deliveries
                     .map(
                       (d) => `<tr>
                         <td>${new Date(d.at).toLocaleTimeString()}</td>
                         <td>${escapeHtml(d.event)}</td>
                         <td style="color:${d.ok ? "var(--green)" : "var(--red)"}">${
                           d.status ?? escapeHtml(d.error ?? "?")
                         }</td>
                         <td>${d.durationMs}</td>
                       </tr>`
                     )
                     .join("")}
                 </tbody>
               </table>`
        }
      </div>
    `;

    root.querySelector<HTMLButtonElement>("#wh-add")?.addEventListener("click", async () => {
      const url = root.querySelector<HTMLInputElement>("#wh-url")!.value.trim();
      if (!url) {
        showToast(t("adj_meg_url_t"), "error");
        return;
      }
      try {
        await api.saveWebhook({
          name: root.querySelector<HTMLInputElement>("#wh-name")!.value,
          url,
          format: root.querySelector<HTMLSelectElement>("#wh-format")!.value as "discord" | "json",
          events: [...root.querySelectorAll<HTMLInputElement>(".wh-event:checked")].map(
            (input) => input.value
          ) as WebhooksResponse["events"],
        });
        void load();
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
      }
    });

    root.querySelectorAll<HTMLButtonElement>("[data-test]").forEach((button) => {
      button.onclick = async () => {
        button.disabled = true;
        try {
          await api.testWebhook(button.dataset.test!);
          void load();
        } catch (err) {
          showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
          button.disabled = false;
        }
      };
    });

    root.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((button) => {
      button.onclick = async () => {
        if (!(await confirmModal(t("biztosan_torlod_a_webhookot")))) return;
        await api.deleteWebhook(button.dataset.del!);
        void load();
      };
    });
  }

  void load();
  return () => {
    disposed = true;
  };
}
