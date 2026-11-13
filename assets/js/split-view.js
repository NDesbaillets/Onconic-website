// Mise en page « liste à gauche (un tiers), fiche à droite (deux tiers) » pour Lettres d'assurance et CTCAE.
// Ordinateur seulement (≥ 1100 px) : en dessous, les pages gardent leurs cartes dépliables. Aucun accès réseau.
(function () {
  const mq = window.matchMedia("(min-width: 1100px)");
  const desktop = () => mq.matches;
  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  // opts : { split, panel, host, empty (nœud affiché quand rien n'est choisi), onClose }
  function create(opts) {
    const { split, panel, host, empty } = opts;
    const closeBtn = panel.querySelector(".sv-close");
    let isOpen = false;
    function clear() {
      isOpen = false;
      split.classList.remove("has-detail");
      empty.hidden = false;
      host.replaceChildren(empty);
    }
    // title : texte ou nœud ; build(holder) remplit la fiche
    function open(title, build) {
      isOpen = true;
      split.classList.add("has-detail");
      host.replaceChildren();
      const h = el("h2", "sv-title");
      h.append(title);
      host.append(h);
      const holder = el("div", "sv-content");
      host.append(holder);
      build(holder);
      panel.scrollTop = 0;
    }
    if (closeBtn) closeBtn.addEventListener("click", () => { clear(); if (opts.onClose) opts.onClose(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen && desktop() && !document.querySelector("dialog[open]") && !(e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) { clear(); if (opts.onClose) opts.onClose(); }
    });
    clear();
    return { open, clear, isOpen: () => isOpen, desktop };
  }
  window.SplitView = { create, desktop, onChange: (fn) => mq.addEventListener("change", fn) };
})();
