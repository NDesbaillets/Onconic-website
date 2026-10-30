// Menu mobile
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-toggle");
  if (!btn) return;
  const nav = document.getElementById(btn.getAttribute("aria-controls"));
  const open = nav.classList.toggle("open");
  btn.setAttribute("aria-expanded", String(open));
});

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
