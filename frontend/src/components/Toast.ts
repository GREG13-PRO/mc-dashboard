let container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  return container;
}

export function showToast(message: string, kind: "info" | "error" = "info") {
  const el = document.createElement("div");
  el.className = `toast${kind === "error" ? " error" : ""}`;
  el.textContent = message;
  ensureContainer().appendChild(el);
  setTimeout(() => el.remove(), 4500);
}
