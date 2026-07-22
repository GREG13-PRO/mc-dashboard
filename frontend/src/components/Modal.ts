export function openModal(content: HTMLElement): () => void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const panel = document.createElement("div");
  panel.className = "modal-panel";
  panel.appendChild(content);
  overlay.appendChild(panel);

  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.body.appendChild(overlay);
  return close;
}

export function confirmModal(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<p>${message}</p>`;
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.textContent = "Mégse";
    const okBtn = document.createElement("button");
    okBtn.className = "btn btn-danger";
    okBtn.textContent = "Igen";
    actions.append(cancelBtn, okBtn);
    wrap.appendChild(actions);

    const close = openModal(wrap);
    cancelBtn.onclick = () => {
      close();
      resolve(false);
    };
    okBtn.onclick = () => {
      close();
      resolve(true);
    };
  });
}
