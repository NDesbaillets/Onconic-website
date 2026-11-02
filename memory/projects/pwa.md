# PWA (app installable)

**Fichiers :** `site.webmanifest`, `sw.js` (racine), `offline.html`, enregistrement et astuce iPhone dans `assets/js/site.js`, styles `.pwa-hint` dans `onconic.css`.

## Ce que ça fait
- Installable (« Sur l'écran d'accueil » sur iPhone, installation depuis Chrome sur Android). Démarre sur `/fr/app/` (The Hive), qui renvoie vers la connexion sans session.
- Service worker : pages en réseau d'abord (4 s max, puis dernière version visitée, puis `offline.html`) ; CSS, JS et images servis depuis le cache et rafraîchis en arrière-plan. Ne touche jamais à Supabase, aux CDN ni aux requêtes autres que GET.
- Astuce d'installation (iPhone/iPad, Safari, hors mode installé) sur l'accueil membres, masquée définitivement par « Compris ».
- Méta iOS ajoutées dans l'en-tête de chaque page (`apple-mobile-web-app-capable`, barre d'état `default`).

## Limites
- Pas de mode hors ligne pour les outils : les données viennent de Supabase. Hors ligne, seules les pages déjà visitées s'ouvrent (coquille vide), sinon `offline.html`.
- Pas de notifications push (possibles sur iPhone seulement pour une PWA installée, iOS 16.4 et plus).
- Sur iPhone, une app installée n'a pas de bouton retour du navigateur : la navigation passe par l'en-tête et « ← The Hive ».

## Entretien
- Changer la logique de `sw.js` : incrémenter `VERSION` (les anciens caches sont supprimés à l'activation).
- Changer les fichiers listés dans `PRECACHE` : ils doivent exister.
- **Désactiver en urgence :** remplacer `sw.js` par
  `self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((k) => Promise.all(k.map((x) => caches.delete(x)))).then(() => self.registration.unregister())));`
  Les navigateurs récupèrent le nouveau `sw.js` à la visite suivante (au plus tard sous 24 h).
