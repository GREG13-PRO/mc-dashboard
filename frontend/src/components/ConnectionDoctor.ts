import { api, ApiError } from "../api";
import { escapeHtml } from "../lib/escape";
import { t } from "../lib/i18n";
import { icon } from "../lib/icons";
import { jumpTo } from "../lib/navigate";
import { showToast } from "./Toast";
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

/** Thrown to abandon an action without drawing it as an error. */
class SilentSkip extends Error {}

/**
 * The public address, as an opt-in.
 *
 * Everything above this line reads files. This starts a third-party program on
 * the operator's machine and makes their server reachable from the internet -
 * two things that must never happen because somebody clicked the wrong button,
 * so the consequences are spelled out and a box has to be ticked before the
 * button does anything at all.
 */
export function renderTunnelPanel(root: HTMLElement, serverId: string): () => void {
  let disposed = false;
  let accepted = false;
  let busy = false;

  function draw(state: import("../types").TunnelState | null, supported: boolean, error?: string) {
    root.innerHTML = `
      <div class="ov-card tn-card">
        <div class="ov-head">
          <span class="ov-icon">${icon("globe", 15)}</span>
          <h4>${escapeHtml(t("nyilvanos_cim"))}</h4>
        </div>
        ${
          !supported
            ? `<p class="ov-note">${escapeHtml(t("alagut_nem_tamogatott"))}</p>`
            : `
          <p class="tn-warn">${escapeHtml(t("alagut_figyelmeztetes"))}</p>
          ${error ? `<p class="tn-error">${escapeHtml(error)}</p>` : ""}
          ${
            state?.running
              ? `
              ${
                state.claimUrl
                  ? `<div class="tn-claim">
                       <p>${escapeHtml(t("alagut_igenyles"))}</p>
                       <a href="${escapeHtml(state.claimUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(state.claimUrl)}</a>
                       <button class="btn btn-primary" id="tn-claimed" ${busy ? "disabled" : ""}>${escapeHtml(t("alagut_kesz"))}</button>
                     </div>`
                  : `<p class="ov-note">${escapeHtml(
                      state.claimed ? t("alagut_fut_igenyelt") : t("alagut_fut")
                    )}</p>`
              }
              <div class="tn-actions">
                <button class="btn btn-danger" id="tn-stop" ${busy ? "disabled" : ""}>${escapeHtml(t("alagut_leallitas"))}</button>
                ${state.claimed ? `<button class="btn" id="tn-reset">${escapeHtml(t("alagut_lecsatolas"))}</button>` : ""}
              </div>`
              : `
              <label class="checkbox-row tn-accept">
                <input type="checkbox" id="tn-accept" ${accepted ? "checked" : ""} />
                <span>${escapeHtml(t("alagut_elfogadom"))}</span>
              </label>
              <button class="btn btn-primary" id="tn-start" ${busy ? "disabled" : ""}>${escapeHtml(t("alagut_inditas"))}</button>`
          }
          ${
            state && state.log.length > 0
              ? `<details class="tn-log"><summary>${escapeHtml(t("naplo"))}</summary><pre>${escapeHtml(
                  state.log.slice(-20).join("\n")
                )}</pre></details>`
              : ""
          }
          <p class="ov-note">${escapeHtml(t("alagut_ugynok"))} ${escapeHtml(state?.agentVersion ?? "")}</p>`
        }
      </div>
    `;

    // Read at the moment of the click rather than mirrored into a variable by
    // a change handler. A button whose enabled state depends on an event
    // firing is a button that can end up permanently dead if it does not - and
    // the tick is checked here, on the route, and nowhere else it could drift
    // from.
    const accept = root.querySelector<HTMLInputElement>("#tn-accept");
    const act = (id: string, fn: () => Promise<import("../types").TunnelState>) => {
      const el = root.querySelector<HTMLButtonElement>(id);
      if (!el) return;
      el.onclick = async () => {
        busy = true;
        el.disabled = true;
        try {
          const next = await fn();
          // Cleared before the redraw, not after it. The new buttons are
          // rendered from `busy`, so drawing while it is still true produced a
          // panel whose controls were disabled for good - the flag was put
          // back afterwards, but the elements it would have enabled had
          // already been replaced.
          busy = false;
          if (!disposed) draw(next, true);
        } catch (err) {
          // A refusal to proceed is not a failure to report as one.
          if (!disposed && !(err instanceof SilentSkip)) {
            draw(null, true, err instanceof ApiError ? err.message : t("nem_sikerult"));
          }
          if (err instanceof SilentSkip) el.disabled = false;
        } finally {
          busy = false;
        }
      };
    };
    act("#tn-start", async () => {
      if (!accept?.checked) {
        showToast(t("alagut_pipa_kell"), "error");
        throw new SilentSkip();
      }
      accepted = true;
      return api.startTunnel(serverId);
    });
    act("#tn-stop", () => api.stopTunnel(serverId));
    act("#tn-claimed", () => api.claimTunnel(serverId));
    act("#tn-reset", () => api.resetTunnel(serverId));
  }

  void (async () => {
    try {
      const { tunnel, supported } = await api.getTunnel(serverId);
      if (!disposed) draw(tunnel, supported);
    } catch (err) {
      if (!disposed) draw(null, true, err instanceof ApiError ? err.message : t("nem_sikerult_betolteni"));
    }
  })();

  return () => {
    disposed = true;
  };
}
