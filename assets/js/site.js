// Menu mobile
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-toggle");
  if (!btn) return;
  const nav = document.getElementById(btn.getAttribute("aria-controls"));
  const open = nav.classList.toggle("open");
  btn.setAttribute("aria-expanded", String(open));
});

// Liens reçus par e-mail (invitation, mot de passe oublié) : Supabase peut renvoyer vers
// n'importe quelle page autorisée. On transmet le jeton à la page « nouveau mot de passe ».
(function () {
  const h = location.hash;
  if (!/type=(invite|recovery)|error_code=/.test(h)) return;
  const fr = location.pathname.startsWith("/fr/") || document.documentElement.lang === "fr";
  const target = fr ? "/fr/nouveau-mot-de-passe.html" : "/reset-password.html";
  if (location.pathname !== target) location.replace(target + h);
})();
