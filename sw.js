// Service worker Onconic : coquille hors ligne, chargement plus rapide, notifications push.
// Ne touche qu'aux fichiers du site (même origine). Supabase, les CDN et toute requête autre que GET passent sans cache.
// Pour désactiver : remplacer ce fichier par un script qui se désinscrit (voir memory/projects/pwa.md).
const VERSION = "onconic-v2";
const STATIC = VERSION + "-static"; // CSS, JS, images
const PAGES = VERSION + "-pages";   // pages HTML déjà visitées
const OFFLINE = "/offline.html";
const PRECACHE = [OFFLINE, "/assets/css/onconic.css", "/assets/img/logo-full-light.svg", "/assets/img/mark-on-light.svg"];
const MAX_STATIC = 150;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC && k !== PAGES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname === "/sw.js") return;
  if (req.mode === "navigate") return e.respondWith(page(req));
  if (/\.(?:css|js|png|jpe?g|webp|svg|ico|woff2?)$/.test(url.pathname)) e.respondWith(asset(e, req));
});

// Pages : réseau d'abord ; si le réseau tarde plus de 4 s ou échoue, dernière version visitée, sinon page hors ligne
async function page(req) {
  const cache = await caches.open(PAGES);
  const cached = await cache.match(req);
  const net = fetch(req).then((res) => {
    if (res.ok && res.type === "basic") cache.put(req, res.clone());
    return res;
  });
  if (!cached) return net.catch(() => caches.match(OFFLINE));
  return Promise.race([net, new Promise((ok) => setTimeout(() => ok(cached), 4000))]).catch(() => cached);
}

// Fichiers : copie en cache servie tout de suite, mise à jour en arrière-plan
async function asset(e, req) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(req);
  const net = fetch(req).then(async (res) => {
    if (res.ok) {
      await cache.put(req, res.clone());
      const keys = await cache.keys();
      if (keys.length > MAX_STATIC) await Promise.all(keys.slice(0, keys.length - MAX_STATIC).map((k) => cache.delete(k)));
    }
    return res;
  });
  if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
  try { return await net; } catch (err) { return (await caches.match(req, { ignoreSearch: true })) || Response.error(); }
}

// Notifications push (envoyées par la fonction « notify-event-join » : { title, body, url, tag })
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Onconic", {
    body: d.body || "",
    icon: "/assets/img/icon-192.png",
    tag: d.tag || undefined,
    data: { url: d.url || "/fr/app/" },
  }));
});

// Un clic ouvre l'événement dans l'app (ou le site) ; l'adresse doit rester sur onconic.ch
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  let target = new URL("/fr/app/", self.location.origin);
  try {
    const u = new URL((e.notification.data && e.notification.data.url) || "/fr/app/", self.location.origin);
    if (u.origin === self.location.origin) target = u;
  } catch (err) { /* adresse invalide : accueil membres */ }
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.location.origin));
    if (open) return open.navigate(target.href).then((c) => (c || open).focus()).catch(() => open.focus());
    return self.clients.openWindow(target.href);
  }));
});
