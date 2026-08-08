import { api, ApiError } from "../api";
import { escapeHtml } from "../lib/escape";
import { t } from "../lib/i18n";
import { icon } from "../lib/icons";
import { jumpTo } from "../lib/navigate";
import type { ConnectionCheck, ConnectionReport } from "../types";

/**
 * "Why can't my friend join?"
 *
 * The most asked question in any Minecraft community, and every piece of the
 * answer was already on this dashboard - on six different screens. Whether the
 * server is up, which port it listens on and on which address, whether the
 * whitelist is on and who is on it, whether the person is banned, what version
 * it speaks, whether the slots are full.
 *
 * The checks arrive in the order a connection actually fails, so the first
 * problem is the first thing on screen. Nine green ticks with one red cross in
 * the middle is a worse answer than "it is the whitelist".
 */

const ICON: Record<ConnectionCheck["status"], string> = {
  ok: "shield",
  problem: "bell",
  warning: "bell",
  unknown: "search",
};

function line(check: ConnectionCheck): string {
  return `
    <div class="cd-check cd-${check.status}">
      <span class="cd-icon">${icon(ICON[check.status], 16)}</span>
      <div class="cd-body">
        <strong>${escapeHtml(check.title)}</strong>
        <p>${escapeHtml(check.detail)}</p>
        ${check.advice ? `<p class="cd-advice">${escapeHtml(check.advice)}</p>` : ""}
      </div>
      ${
        check.goTo
          ? `<button class="btn cd-go" data-tab="${escapeHtml(check.goTo)}">${escapeHtml(t("odaugras"))}</button>`
          : ""
      }
    </div>`;
}

export function renderConnectionDoctor(root: HTMLElement, serverId: string): () => void {
  let disposed = false;
  let name = "";

  function draw(report: ConnectionReport | null, error?: string) {
    const problems = report?.checks.filter((c) => c.status === "problem") ?? [];
    root.innerHTML = `
      <div class="cd-root">
        <form class="cd-ask" id="cd-ask">
          <input id="cd-name" type="text" maxlength="16" autocomplete="off"
                 placeholder="${escapeHtml(t("kinek_a_neve"))}" value="${escapeHtml(name)}" />
          <button class="btn btn-primary" type="submit">${escapeHtml(t("ellenorzes"))}</button>
        </form>
        <p class="cd-note">${escapeHtml(t("csatlakozas_leiras"))}</p>
        ${
          error
            ? `<div class="empty-state" style="padding:16px;">${escapeHtml(error)}</div>`
            : !report
              ? `<div class="empty-state" style="padding:16px;">${escapeHtml(t("betoltes"))}</div>`
              : `
          <div class="cd-verdict cd-${problems.length === 0 ? "ok" : "problem"}">
            ${
              problems.length === 0
                ? `<strong>${escapeHtml(t("minden_rendben"))}</strong>
                   ${
                     report.lanAddress
                       ? `<span>${escapeHtml(t("ezt_add_meg"))}: <code>${escapeHtml(
                           report.lanAddress
                         )}${report.port === 25565 ? "" : `:${report.port}`}</code></span>`
                       : ""
                   }`
                : `<strong>${escapeHtml(problems[0].title)}</strong>
                   <span>${escapeHtml(problems[0].detail)}</span>`
            }
          </div>
          <div class="cd-checks">${report.checks.map(line).join("")}</div>`
        }
      </div>
    `;

    root.querySelectorAll<HTMLButtonElement>(".cd-go").forEach((el) => {
      el.onclick = () => jumpTo({ serverId, tab: el.dataset.tab! });
    });
    const form = root.querySelector<HTMLFormElement>("#cd-ask")!;
    const input = root.querySelector<HTMLInputElement>("#cd-name")!;
    form.onsubmit = (e) => {
      e.preventDefault();
      name = input.value.trim();
      void load();
    };
  }

  async function load() {
    if (disposed) return;
    try {
      const report = await api.diagnoseConnection(serverId, name || undefined);
      if (!disposed) draw(report);
    } catch (err) {
      if (!disposed) draw(null, err instanceof ApiError ? err.message : t("nem_sikerult_betolteni"));
    }
  }

  draw(null);
  void load();

  return () => {
    disposed = true;
  };
}
