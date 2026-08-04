import { api, ApiError } from "../api";
import { t } from "../lib/i18n";
import { escapeHtml } from "../lib/escape";
import { currentUsername } from "../auth-state";
import type { AdminXp } from "../types";
import { pageHead } from "../components/PageHead";

export function renderXpView(root: HTMLElement): () => void {
  let disposed = false;

  root.innerHTML = `<div class="empty-state">${t("betoltes")}</div>`;

  async function load() {
    let data;
    try {
      data = await api.getAdminXp();
    } catch (err) {
      root.innerHTML = `<div class="empty-state">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
      return;
    }
    if (disposed) return;
    render(data.leaderboard, data.rules);
  }

  function render(board: AdminXp[], rules: { label: string; points: number }[]) {
    const me = currentUsername();

    root.innerHTML = `
      ${pageHead({
        icon: "star",
        title: t("admin_szintek"),
        description: t("hub_xp"),
        actions: `<button class="btn" id="xp-refresh">${t("frissites")}</button>`,
      })}
      <div class="tab-content">
        <p style="max-width:640px;color:var(--text-dim);font-size:12px;margin-top:0;">${t("a_pontok_az_auditnaplobol_szamolodnak_visszameno")}</p>

        ${
          board.length === 0
            ? `<div class="empty-state" style="padding:16px;">${t("meg_nincs_pontszerzo")}</div>`
            : board
                .map((a, i) => {
                  const mine = a.username === me;
                  const pct = Math.round((a.progress / a.nextLevelAt) * 100);
                  return `
        <div style="padding:12px;margin-bottom:8px;border:0.5px solid ${
          mine ? "var(--accent)" : "var(--border)"
        };border-radius:var(--radius-md);${mine ? "background:var(--accent-dim);" : ""}">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">
            <div>
              <span style="color:var(--text-dim);font-size:12px;">#${i + 1}</span>
              <span style="font-weight:600;margin-left:6px;">${escapeHtml(a.username)}</span>
              ${mine ? `<span class="pb-badge" style="margin-left:6px;">${t("te")}</span>` : ""}
            </div>
            <div style="font-size:13px;">
              <strong>${a.level}. szint</strong>
              <span style="color:var(--text-dim);"> · ${a.points} pont · ${a.actions} művelet</span>
            </div>
          </div>

          <div style="height:6px;border-radius:999px;background:var(--bg-inset);margin:8px 0 4px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:var(--accent);"></div>
          </div>
          <div style="color:var(--text-dim);font-size:11px;">
            ${a.progress} / ${a.nextLevelAt} a következő szintig${
              a.lastActiveAt ? ` · utoljára aktív: ${new Date(a.lastActiveAt).toLocaleString("hu-HU")}` : ""
            }
          </div>

          ${
            a.breakdown.length > 0
              ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
                   ${a.breakdown
                     .map(
                       (b) =>
                         `<span class="pb-badge">${escapeHtml(b.label)} · ${b.points}p (${b.count}×)</span>`
                     )
                     .join("")}
                 </div>`
              : ""
          }
        </div>`;
                })
                .join("")
        }

        <h4 style="margin:24px 0 8px;">${t("pontozas")}</h4>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${rules
            .map((r) => `<span class="pb-badge">${escapeHtml(r.label)} · ${r.points}p</span>`)
            .join("")}
        </div>
      </div>
    `;

    root.querySelector<HTMLButtonElement>("#xp-refresh")!.onclick = () => void load();
  }

  void load();

  return () => {
    disposed = true;
  };
}
