import { t } from "../lib/i18n";
import { icon } from "../lib/icons";
import { pageHead } from "../components/PageHead";

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
  icon: string;
  label: string;
  description: string;
}

export function renderAdminHubView(root: HTMLElement): () => void {
  const entries: HubEntry[] = [
    { hash: "#/users", icon: "users", label: t("felhasznalok"), description: t("hub_felhasznalok") },
    { hash: "#/audit", icon: "clipboard", label: t("auditnaplo"), description: t("hub_audit") },
    { hash: "#/app", icon: "download", label: t("alkalmazasok"), description: t("hub_alkalmazasok") },
    { hash: "#/lab", icon: "flask", label: t("plugin_labor"), description: t("hub_labor") },
    { hash: "#/webhooks", icon: "bell", label: t("webhookok"), description: t("hub_webhookok") },
  ];

  root.innerHTML = `
    ${pageHead({ icon: "sliders", title: t("kezeles"), description: t("kezeles_leiras") })}
    <div class="section" style="padding:16px;">
      <div class="hub-grid">
        ${entries
          .map(
            (entry) => `
          <a class="hub-card" href="${entry.hash}">
            <span class="hub-icon">${icon(entry.icon, 18)}</span>
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
