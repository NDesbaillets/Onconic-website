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
  if (!("IntersectionObserver" in window)) return items.forEach((el) => el.classList.add("revealed"));
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
