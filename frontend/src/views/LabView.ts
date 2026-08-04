import { EditorView, basicSetup } from "codemirror";
import { api, ApiError } from "../api";
import { escapeHtml } from "../lib/escape";
import { t } from "../lib/i18n";
import { confirmModal } from "../components/Modal";
import { showToast } from "../components/Toast";
import type { LabProject, LabToolchain, ServerWithStatus } from "../types";
import { pageHead } from "../components/PageHead";

/**
 * Write a plugin, compile it, put it on a test server.
 *
 * One file per project deliberately: this is for trying a command or a
 * listener and seeing it work half a minute later. Anything that needs a
 * package structure has outgrown a browser tab.
 */
export function renderLabView(root: HTMLElement): () => void {
  let disposed = false;
  let editor: EditorView | null = null;
  let projects: LabProject[] = [];
  let toolchain: LabToolchain = { javac: null, jar: null };
  let servers: ServerWithStatus[] = [];
  let current: string | null = null;

  function teardownEditor() {
    editor?.destroy();
    editor = null;
  }

  async function load() {
    if (disposed) return;
    try {
      const [labs, list] = await Promise.all([api.listLabProjects(), api.listServers()]);
      projects = labs.projects;
      toolchain = labs.toolchain;
      servers = list;
    } catch (err) {
      root.innerHTML = `<div class="empty-state">${escapeHtml(
        err instanceof ApiError ? err.message : t("nem_sikerult_betolteni")
      )}</div>`;
      return;
    }
    if (disposed) return;
    if (current && !projects.some((p) => p.name === current)) current = null;
    if (!current && projects.length > 0) current = projects[0].name;
    paint();
  }

  function paint() {
    teardownEditor();
    const project = projects.find((p) => p.name === current) ?? null;

    root.innerHTML = `
      ${pageHead({ icon: "flask", title: t("plugin_labor"), description: t("hub_labor") })}
      <div class="section" style="padding:16px;">
        <p class="finding-advice" style="margin:0 0 10px;">${t("plugin_labor_leiras")}</p>
        ${
          toolchain.javac && toolchain.jar
            ? `<p class="finding-detail">${t("forditó")}: ${escapeHtml(toolchain.javac)}</p>`
            : `<div class="finding finding-warning"><p class="finding-detail">${t(
                "nincs_jdk"
              )}</p><p class="finding-advice">sudo apt install openjdk-21-jdk-headless</p></div>`
        }

        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0;">
          <select id="lab-project" ${projects.length === 0 ? "disabled" : ""}>
            ${projects
              .map(
                (p) =>
                  `<option value="${escapeHtml(p.name)}" ${
                    p.name === current ? "selected" : ""
                  }>${escapeHtml(p.name)}</option>`
              )
              .join("")}
          </select>
          <button class="btn" id="lab-new">${t("uj_projekt")}</button>
          ${project ? `<button class="btn btn-danger" id="lab-delete">${t("torles")}</button>` : ""}
        </div>

        ${
          project
            ? `<div id="lab-editor" class="lab-editor"></div>
               <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px;">
                 <select id="lab-server">
                   ${servers
                     .map(
                       (s) =>
                         `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}${
                           s.running ? ` · ${t("fut")}` : ""
                         }</option>`
                     )
                     .join("")}
                 </select>
                 <button class="btn" id="lab-save">${t("mentes")}</button>
                 <button class="btn" id="lab-compile">${t("forditas")}</button>
                 <button class="btn btn-primary" id="lab-deploy">${t("telepites")}</button>
                 <label class="checkbox-row" style="margin:0;">
                   <input type="checkbox" id="lab-reload" />
                   <span style="margin-left:6px;">${t("ujratoltes_is")}</span>
                 </label>
               </div>
               <p class="finding-advice" style="margin-top:6px;">${t("reload_figyelmeztetes")}</p>
               <pre class="lab-output" id="lab-output"></pre>`
            : `<div class="empty-state">${t("nincs_lab_projekt")}</div>`
        }
      </div>
    `;

    if (project) {
      editor = new EditorView({
        doc: project.source,
        extensions: [basicSetup],
        parent: root.querySelector<HTMLDivElement>("#lab-editor")!,
      });
    }
    bind();
  }

  function output(text: string, ok = true) {
    const box = root.querySelector<HTMLPreElement>("#lab-output");
    if (!box) return;
    box.textContent = text;
    box.classList.toggle("lab-output-error", !ok);
  }

  function selectedServer(): string {
    return root.querySelector<HTMLSelectElement>("#lab-server")?.value ?? "";
  }

  async function save(): Promise<boolean> {
    if (!current || !editor) return false;
    try {
      await api.saveLabProject(current, editor.state.doc.toString());
      const project = projects.find((p) => p.name === current);
      if (project) project.source = editor.state.doc.toString();
      return true;
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : t("mentes_sikertelen"), "error");
      return false;
    }
  }

  function bind() {
    root.querySelector<HTMLSelectElement>("#lab-project")?.addEventListener("change", (e) => {
      current = (e.target as HTMLSelectElement).value;
      paint();
    });

    root.querySelector<HTMLButtonElement>("#lab-new")?.addEventListener("click", async () => {
      const name = window.prompt(t("projekt_neve"));
      if (!name) return;
      try {
        const created = await api.saveLabProject(name);
        current = created.name;
        await load();
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : t("nem_sikerult"), "error");
      }
    });

    root.querySelector<HTMLButtonElement>("#lab-delete")?.addEventListener("click", async () => {
      if (!current || !(await confirmModal(t("biztosan_torlod_a_projektet")))) return;
      await api.deleteLabProject(current);
      current = null;
      await load();
    });

    root.querySelector<HTMLButtonElement>("#lab-save")?.addEventListener("click", async () => {
      if (await save()) showToast(t("mentve"));
    });

    root.querySelector<HTMLButtonElement>("#lab-compile")?.addEventListener("click", async () => {
      if (!current || !(await save())) return;
      output(t("forditas_folyamatban"));
      try {
        const result = await api.compileLabProject(current, selectedServer());
        output(`${result.minecraftVersion}\n\n${result.output}`, result.ok);
      } catch (err) {
        output(err instanceof ApiError ? err.message : String(err), false);
      }
    });

    root.querySelector<HTMLButtonElement>("#lab-deploy")?.addEventListener("click", async () => {
      if (!current || !(await save())) return;
      const reload = root.querySelector<HTMLInputElement>("#lab-reload")?.checked ?? false;
      output(t("telepites_folyamatban"));
      try {
        const result = await api.deployLabProject(current, selectedServer(), reload);
        output(
          [`${t("telepitve")}: ${result.installed}`, result.reloadOutput ?? ""].join("\n").trim()
        );
      } catch (err) {
        output(err instanceof ApiError ? err.message : String(err), false);
      }
    });
  }

  void load();
  return () => {
    disposed = true;
    teardownEditor();
  };
}
