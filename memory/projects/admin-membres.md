# Administration des membres (01.11.2026)

**Page :** `/admin/membres.html` (tuile « Administration » dans The Hive, admin seulement) · **JS :** `assets/js/admin-members.js` · **SQL :** `supabase/admin.sql` + bloc « Accès par outil » de `supabase/schema.sql`

- Liste : nom, prénom, e-mail (auth.users), rôle, institution, inscription, dernière connexion ; comptes en attente en tête.
- Rôle modifiable (jamais le sien) ; un changement de rôle efface les exceptions d'accès.
- Accès par outil : `public.tool_allowed(user, tool)` = droit par défaut du rôle (identique aux règles d'avant) puis exception `tool_access`. Outils : congres, trials, lettres, limitations, duree, medletters (ce dernier via `profiles.med_plus`).
- Toutes les règles RLS des outils passent par `has_tool('outil')` ; l'administration d'un outil par le pharmacien passe par `is_app_admin('outil')` (perd l'admin s'il perd l'accès).
- The Hive : tuiles `data-tool`, visibilité via `my_tools()`.
