# Administration des membres (01.11.2026)

**Page :** `/admin/membres.html` (tuile « Administration » dans The Hive, admin seulement) · **JS :** `assets/js/admin-members.js` · **SQL :** `supabase/admin.sql` + bloc « Accès par outil » de `supabase/schema.sql`

- Liste : nom, prénom, e-mail (auth.users), rôle, institution, inscription, dernière connexion ; comptes en attente en tête.
- Rôle modifiable (jamais le sien) ; un changement de rôle efface les exceptions d'accès.
- Accès par outil : `public.tool_allowed(user, tool)` = droit par défaut du rôle (identique aux règles d'avant) puis exception `tool_access`. Outils : congres, trials, lettres, limitations, duree, medletters (ce dernier via `profiles.med_plus`).
- Toutes les règles RLS des outils passent par `has_tool('outil')` ; l'administration d'un outil par le pharmacien passe par `is_app_admin('outil')` (perd l'admin s'il perd l'accès).
- The Hive : tuiles `data-tool`, visibilité via `my_tools()`.


## Rôle CDC (chef de clinique)
Rôle `cdc` (ex « CDC / Cadre », renommé le 06.11.2026 ; « Cadre » est devenu un rôle distinct, voir absences.md) : droits d'un médecin, plus gestion des fiches Key trials des cliniques cochées sur la fiche du membre (`admin_set_cdc_clinics`). Le changement de rôle efface les cliniques.

## Rôle cadre (médecin cadre, 06.11.2026)
Exactement les droits d'un CDC (tous les outils, Key trials par `cdc_clinics`, cliniques de rattachement), plus la validation des absences s'il est désigné valideur d'une clinique. Voir absences.md et `supabase/cadre_medecin.sql`.
Case « Validateur des absences » (cadre seulement, 06.11.2026) : `admin_set_absence_validator`, colonne `profiles.absence_validator` ; seuls les cadres cochés sont proposés dans `/admin/absences.html`.

## Mise en page liste et fiche (13.11.2026)
`/admin/membres.html` : sur ordinateur (≥ 1100 px), la liste des membres occupe un tiers de la fenêtre (recherche, filtre par rôle, comptes en attente en tête, badges rôle, « exception » et « validateur ») et la fiche du membre choisi s'ouvre sur les deux tiers de droite, comme Key trials ; chaque colonne défile seule. Sur téléphone et tablette, la liste puis la fiche en plein écran avec « ← Liste des membres ». Lien direct `#u=<id>`, Échap ferme la fiche. Les demandes de changement de cliniques sont dans un bloc repliable au-dessus (ouvert s'il y en a). Fichiers : `admin/membres.html`, `assets/js/admin-members.js`, `assets/css/admin-members.css`. Test navigateur : `node tests/absences/admin-members-ui.mjs` (Playwright, réponses simulées). Aucun changement SQL.
