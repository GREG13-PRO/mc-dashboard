import { t } from "../lib/i18n";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function openModal(content: HTMLElement): () => void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  const panel = document.createElement("div");
  panel.className = "modal-panel";
  panel.appendChild(content);
  overlay.appendChild(panel);

  // Returning focus matters for anyone navigating by keyboard: without it,
  // closing a dialog drops the caret back at the top of the document.
  const previouslyFocused = document.activeElement as HTMLElement | null;

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKeydown, true);
    previouslyFocused?.focus?.();
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    // Tab cycles within the dialog rather than escaping into the page behind
    // it, which is unreachable while the dialog is open anyway.
    const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  document.addEventListener("keydown", onKeydown, true);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.body.appendChild(overlay);

  panel.querySelector<HTMLElement>(FOCUSABLE)?.focus();
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
    cancelBtn.textContent = t("megse");
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
