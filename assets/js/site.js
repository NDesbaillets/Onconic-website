// Accord singulier/pluriel (français : 0 et 1 au singulier). plur(2, "lettre", "lettres") -> "2 lettres"
window.plur = (n, one, many) => n + " " + (n > 1 ? many : one);

// Menu mobile : se ferme avec Échap, un clic extérieur ou le choix d'un lien
(function () {
  const setOpen = (btn, open, focusBtn) => {
    const nav = document.getElementById(btn.getAttribute("aria-controls"));
    if (!nav) return;
    nav.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    if (!open && focusBtn) btn.focus();
  };
  document.addEventListener("click", (e) => {
    const btn = document.querySelector(".nav-toggle");
    if (!btn) return;
    const toggle = e.target.closest(".nav-toggle");
    const nav = document.getElementById(btn.getAttribute("aria-controls"));
    if (toggle) return setOpen(btn, btn.getAttribute("aria-expanded") !== "true");
    if (nav && nav.classList.contains("open") && (e.target.closest("#" + nav.id + " a") || !e.target.closest(".site-header"))) setOpen(btn, false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const btn = document.querySelector(".nav-toggle");
    if (btn && btn.getAttribute("aria-expanded") === "true") setOpen(btn, false, true);
  });
})();

// Retour à The Hive toujours accessible : sur les pages d'outils (membres et admin), un lien persistant s'ajoute dans l'en-tête
// collant, à côté du logo, donc visible en haut de page, après défilement et sur mobile sans ouvrir le menu.
(function () {
  const back = document.querySelector("a.hive-back");
  const brand = document.querySelector(".site-header .brand");
  if (!back || !brand || document.querySelector(".hive-home")) return;
  const a = document.createElement("a");
  a.className = "hive-home";
  a.href = back.getAttribute("href");
  a.textContent = back.textContent.trim() || "← The Hive";
  brand.after(a);
  document.body.classList.add("has-hive-home");
})();

// Liens reçus par e-mail : Supabase peut renvoyer vers n'importe quelle page autorisée.
// Invitation → page de bienvenue (mot de passe + profil) ; mot de passe oublié → « nouveau mot de passe ».
(function () {
  const h = location.hash;
  if (!/type=(invite|recovery)|error_code=/.test(h)) return;
  const fr = location.pathname.startsWith("/fr/") || document.documentElement.lang === "fr";
  const invite = /type=invite/.test(h) || (/error_code=/.test(h) && /bienvenue|welcome/.test(location.pathname));
  const target = invite ? (fr ? "/fr/bienvenue.html" : "/welcome.html") : (fr ? "/fr/nouveau-mot-de-passe.html" : "/reset-password.html");
  if (location.pathname !== target) location.replace(target + h);
})();

// Apparition progressive des éléments marqués data-reveal (alvéoles de The Hive)
(function () {
  const items = document.querySelectorAll("[data-reveal]");
  if (!items.length) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return items.forEach((el) => el.classList.add("revealed"));
  // Le masquage initial n'existe que si ce script tourne : sans lui, tout reste visible
  document.documentElement.classList.add("reveal-on");
  setTimeout(() => items.forEach((el) => el.classList.add("revealed")), 3000);
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("revealed");
      io.unobserve(e.target);
    });
  }, { threshold: 0.15 });
  items.forEach((el) => io.observe(el));
})();

// PWA : service worker (coquille hors ligne, voir /sw.js)
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
}

// Astuce d'installation sur iPhone/iPad : Safari ne propose pas d'invite, il faut passer par « Partager »
(function () {
  const hub = document.getElementById("hive-app");
  if (!hub) return;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!ios || navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches)) return;
  try { if (localStorage.getItem("onconic-pwa-hint") === "1") return; } catch (e) { /* stockage indisponible : on affiche */ }
  const fr = document.documentElement.lang === "fr";
  const box = document.createElement("aside");
  box.className = "pwa-hint";
  box.setAttribute("role", "note");
  const p = document.createElement("p");
  p.textContent = fr
    ? "Pour retrouver Onconic comme une app : touchez Partager (le carré avec une flèche), puis « Sur l'écran d'accueil »."
    : "To get Onconic like an app: tap Share (the square with an arrow), then “Add to Home Screen”.";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn btn-outline";
  b.textContent = fr ? "Compris" : "Got it";
  b.addEventListener("click", () => {
    try { localStorage.setItem("onconic-pwa-hint", "1"); } catch (e) { /* tant pis */ }
    box.remove();
  });
  box.append(p, b);
  const first = hub.querySelector(".section .container");
  if (first) first.prepend(box);
})();

// Lien d'évitement : premier élément atteignable au clavier, mène au contenu principal
(function () {
  const main = document.querySelector("main");
  if (!main || document.querySelector(".skip-link")) return;
  if (!main.id) main.id = "main";
  main.tabIndex = -1;
  const a = document.createElement("a");
  a.className = "skip-link";
  a.href = "#" + main.id;
  a.textContent = document.documentElement.lang === "fr" ? "Aller au contenu" : "Skip to content";
  document.body.prepend(a);
})();

// Sélecteur rapide de mois (Congrès, Absences) : un clic sur le mois affiché ouvre l'année (flèches ou saisie) et les 12 mois.
// monthPicker(bouton, { get: () => ({ y, m }), onPick: (y, m) => … }) ; m va de 0 à 11.
window.monthPicker = function (trigger, opts) {
  const NAMES = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
  const SHORT = ["Janv.", "Févr.", "Mars", "Avr.", "Mai", "Juin", "Juil.", "Août", "Sept.", "Oct.", "Nov.", "Déc."];
  const MIN = 1990, MAX = 2100;
  let pop = null;
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.parentElement.classList.add("mp-host");
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const btn = (txt, cls, label, fn) => { const b = mk("button", cls, txt); b.type = "button"; if (label) b.setAttribute("aria-label", label); b.addEventListener("click", fn); return b; };

  function close(refocus) {
    if (!pop) return;
    pop.remove();
    pop = null;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("click", onDoc, true);
    if (refocus) trigger.focus();
  }
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(true); } };
  const onDoc = (e) => { if (pop && !pop.contains(e.target) && !trigger.contains(e.target)) close(false); };

  function open() {
    const cur = opts.get();
    const now = new Date();
    let year = cur.y;
    pop = mk("div", "mp-pop");
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Choisir un mois");
    const bar = mk("div", "mp-years");
    const input = mk("input", "mp-year");
    input.type = "number"; input.min = MIN; input.max = MAX; input.step = 1; input.value = year;
    input.setAttribute("aria-label", "Année");
    const grid = mk("div", "mp-grid");
    const setYear = (y) => { const v = Math.min(MAX, Math.max(MIN, y)); input.value = v; if (v === year && grid.children.length) return; year = v; paint(); };
    bar.append(btn("‹", "mp-step", "Année précédente", () => setYear(year - 1)), input, btn("›", "mp-step", "Année suivante", () => setYear(year + 1)));
    input.addEventListener("change", () => { const v = parseInt(input.value, 10); setYear(Number.isFinite(v) ? v : cur.y); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.dispatchEvent(new Event("change")); } });
    function paint() {
      grid.replaceChildren(...NAMES.map((n, i) => {
        const b = btn(SHORT[i], "mp-m", n + " " + year, () => { close(true); opts.onPick(year, i); });
        if (year === cur.y && i === cur.m) b.setAttribute("aria-pressed", "true");
        if (year === now.getFullYear() && i === now.getMonth()) b.classList.add("now");
        return b;
      }));
    }
    paint();
    const foot = mk("div", "mp-foot");
    foot.append(btn("Aujourd'hui", "mp-today", null, () => { close(true); opts.onPick(now.getFullYear(), now.getMonth()); }), btn("Fermer", "mp-close", null, () => close(true)));
    pop.append(bar, grid, foot);
    trigger.after(pop);
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("click", onDoc, true);
    const sel = grid.querySelector('[aria-pressed="true"]') || grid.querySelector(".now") || grid.firstChild;
    if (sel) sel.focus();
  }
  trigger.addEventListener("click", () => { if (pop) close(true); else open(); });
};
