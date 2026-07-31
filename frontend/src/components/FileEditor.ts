import { EditorView, basicSetup } from "codemirror";
import { api, ApiError } from "../api";
import { showToast } from "../components/Toast";

export function openFileEditor(serverId: string, filePath: string, initialContent: string): () => void {
  const overlay = document.createElement("div");
  overlay.className = "file-editor-overlay";

  const panel = document.createElement("div");
  panel.className = "file-editor-panel";

  const header = document.createElement("div");
  header.className = "file-editor-header";
  header.innerHTML = `<strong>${filePath}</strong>`;

  const actions = document.createElement("div");
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-primary";
  saveBtn.textContent = "Mentés";
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn";
  closeBtn.textContent = "Bezárás";
  closeBtn.style.marginLeft = "0.5rem";
  actions.append(saveBtn, closeBtn);
  header.appendChild(actions);

  const body = document.createElement("div");
  body.className = "file-editor-body";

  panel.append(header, body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const view = new EditorView({
    doc: initialContent,
    extensions: [basicSetup],
    parent: body,
  });

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKeydown, true);

  const close = () => {
    document.removeEventListener("keydown", onKeydown, true);
    view.destroy();
    overlay.remove();
  };

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  closeBtn.onclick = close;
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      await api.writeFile(serverId, filePath, view.state.doc.toString());
      showToast("Fájl elmentve");
      close();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Mentés sikertelen", "error");
    } finally {
      saveBtn.disabled = false;
    }
  };

  return close;
}
