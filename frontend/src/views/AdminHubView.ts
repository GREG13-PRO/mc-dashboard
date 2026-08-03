import { t } from "../lib/i18n";

/**
 * One entry in the sidebar instead of six.
 *
 * The sidebar's job is picking a server; every admin screen added to it pushed
 * the server list further down and made the one thing anyone opens the
 * dashboard for harder to find. These are all destinations you visit
 * occasionally and deliberately, which is exactly what a hub page is for.
 *
 * Admin levels are not here: they are the one screen every user can open, so
 * they stay in the sidebar rather than being listed in two places.
 */
interface HubEntry {
  hash: string;
  label: string;
  description: string;
}

export function renderAdminHubView(root: HTMLElement): () => void {
  const entries: HubEntry[] = [
    { hash: "#/users", label: t("felhasznalok"), description: t("hub_felhasznalok") },
    { hash: "#/audit", label: t("auditnaplo"), description: t("hub_audit") },
    { hash: "#/app", label: t("alkalmazasok"), description: t("hub_alkalmazasok") },
    { hash: "#/lab", label: t("plugin_labor"), description: t("hub_labor") },
    { hash: "#/webhooks", label: t("webhookok"), description: t("hub_webhookok") },
  ];

  root.innerHTML = `
    <div class="server-view-header">
      <h2>${t("kezeles")}</h2>
    </div>
    <div class="section" style="padding:16px;">
      <div class="hub-grid">
        ${entries
          .map(
            (entry) => `
          <a class="hub-card" href="${entry.hash}">
            <strong>${entry.label}</strong>
            <span>${entry.description}</span>
          </a>`
          )
          .join("")}
      </div>
    </div>
  `;

  return () => {};
}
