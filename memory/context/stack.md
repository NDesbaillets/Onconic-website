# Contexte technique Onconic

## Hébergement et code
- Site statique GitHub Pages, dépôt `NDesbaillets/Onconic-website` (public), domaine onconic.ch.
- HTML/CSS/JS vanilla, bilingue (`/fr/...` et racine en anglais).
- CSP stricte : `script-src 'self' https://cdn.jsdelivr.net`, pas de style inline, `connect-src` limité à `*.supabase.co`.
- Assets versionnés par `?v=AAAAMMJJx` : incrémenter à chaque modification (CSS partagé : `assets/css/onconic.css`).
- Bibliothèques (jsdelivr) : supabase-js 2.57.4 UMD, mammoth 1.8.0, ExcelJS 4.4.0.

## Supabase
- Projet `icqrobnqvidusajburcu` (auth sur invitation, Postgres + RLS, Edge Functions).
- Fonctions SQL : `current_role_name()`, `current_institution()`, `is_hive_member()`.
- Scripts dans `supabase/` (un par app), à exécuter dans le SQL Editor ; conçus pour être relancés sans risque.
- Modèle d'e-mail d'invitation : `supabase/templates/invite.html` (à recoller dans Authentication › Email Templates).

## Tests (session cloud)
- Playwright avec Supabase simulé (routes interceptées, faux jeton dans localStorage `sb-icqrobnqvidusajburcu-auth-token`).
- PGlite pour tester SQL et RLS (stub `auth.uid()` via `current_setting('test.uid')`).
- Serveur local : `python3 -m http.server 8772` à la racine du dépôt.

## Workflow Git
- Branche `claude/quirky-tesla-kpblcm`, toujours repartie de `origin/main` après chaque merge (pas de force-push).
- Commits terminés par les lignes Co-Authored-By / Claude-Session ; PR via MCP GitHub, puis suivi de la PR.
