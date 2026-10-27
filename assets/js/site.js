// Menu mobile
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-toggle");
  if (!btn) return;
  const nav = document.getElementById(btn.getAttribute("aria-controls"));
  const open = nav.classList.toggle("open");
  btn.setAttribute("aria-expanded", String(open));
});
