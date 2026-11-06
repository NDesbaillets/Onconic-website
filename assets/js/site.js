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
