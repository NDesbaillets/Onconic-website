# Key trials

**Page :** `/app/trials.html` · **JS :** `assets/js/trials.js` · **SQL :** `supabase/trials.sql`
**Source des fiches :** générées par script (hors dépôt) ; le SQL contient les 14 fiches en JSON.

## Contenu d'une fiche
Schéma de l'étude (SVG : population et critères d'inclusion → randomisation → bras → critères), section « Traitements de l'étude » (doses, voie, schéma, durée, bouton copier), courbes PFS/OS, forest plot des HR, tableau, tolérance, discussion (forces, limites, practice changing), références PubMed/DOI.

## Tolérance et copie des schémas (décision du 31.10.2026)
- Champ `ae` (jsonb) : { arms, grade, rows: [[effet, tous grades, grade ≥ 3 ou 3-4, …]], source }, affiché en tableau sous « Tolérance », `safety` reste la phrase de synthèse.
- Sources : tableaux des notices FDA (DailyMed) des études pivots ; KEYNOTE-024 et -407 seulement en lignes de synthèse (tableaux JCO en image, NEJM non libre) : détail par effet à compléter à la relecture. LIBRETTO-001 : population poolée toutes tumeurs (n = 857).
- « Copier » ne copie que le traitement expérimental : bras `control: true` exclus (à défaut, premier bras d'une étude randomisée). Sans bras contrôle (VISION, LIBRETTO-001, DESTINY-Lung02) : tous les bras.

## Courbes de survie (décision du 31.10.2026)
- Digitalisées depuis la figure publiée la plus récente en libre accès (Europe PMC API `.../rest/PMCxxxx/supplementaryFiles`), points tous les 0,5 mois, effectifs à risque, valeurs publiées en points. Précision vérifiée : médianes ±0,5 mois, taux ±2 points.
- Digitalisées : KEYNOTE-189, -407, -024 (5 ans), CheckMate 9LA (6 ans), CROWN (5 ans), CASPIAN (3 ans), VISION (long terme), LIBRETTO-001 (mise à jour), DESTINY-Lung02.
- Reconstruites (figure non libre d'accès) : FLAURA, FLAURA2 (OS finale NEJM 2026), ADAURA, ALTA-1L (analyse finale JTO 2021). IMpower010 : pas de courbe.
- Jamais d'extrapolation au-delà du suivi publié pour les courbes digitalisées.
- Pour digitaliser les 5 restantes : il faut que Nicolas fournisse les figures (PDF/captures).

## État
- 14 fiches en brouillon dans la base, aucune relue ni publiée.
- Doses à vérifier en priorité : chimiothérapie du bras contrôle KEYNOTE-024, doublets adjuvants et stratification d'IMpower010.
- Relancer `trials.sql` met à jour seulement les fiches non modifiées à la main et non relues.

## Visibilité, brouillons et rôle CDC (décision du 04.11.2026)
- Toutes les fiches, brouillons compris, sont visibles de tous les utilisateurs de l'outil. Une fiche en brouillon affiche un bandeau « Brouillon : pas encore relue ni validée par un médecin cadre » et un badge « Brouillon ». Le 04.11.2026, les 11 fiches publiées sont repassées en brouillon.
- Rôle `cdc` (« CDC », chef de clinique) : droits d'un médecin, plus modification et validation (statut publié, relu par) des fiches des cliniques que l'admin lui attribue (`profiles.cdc_clinics`, une ou plusieurs, réglées dans `/admin/membres.html`). Droit contrôlé en base par `can_edit_trials(clinic)` (RLS de `key_trials`). Suppression de fiche : admin seulement.
- Chaque fiche porte un sélecteur de clinique (modifiable par l'admin et les CDC de la clinique ; un CDC ne peut attribuer que ses cliniques).
- Signalement « à réviser » : tout utilisateur peut signaler une fiche avec un commentaire (table `trial_flags`). Les signalements ouverts apparaissent sur la fiche et dans la section « À réviser » en bas de page pour les admins et les CDC de la clinique, avec « Marquer comme traité ».
- SQL : `supabase/trials_roles.sql`.
