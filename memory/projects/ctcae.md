# CTCAE v5 et v6

**Page :** `/app/ctcae.html` · **JS :** `assets/js/ctcae.js` · **Données :** `assets/data/ctcae.json` · **Construction :** `tools/ctcae/build_ctcae.py` (+ `fr_terms.json`, `fr_grades.json`)

Outil de recherche du grading CTCAE (symptôme ou anomalie biologique), versions 5.0 et 6.0, anglais et français. Accès : médecins (dont CDC), pharmaciens, admins (alvéole « Physicians » de The Hive, sans entrée `tool_access` : accès par rôle, vérifié dans la page). Aucune donnée de patient, aucun SQL.

## Données
- Source : fichiers NCIt du NCI (domaine public) `CTCAE_5.0_NCIt.xls` (MedDRA 20.1) et `NCIt_CTCAE_6.0_2025-09-11.xls` (MedDRA 28.0). Les Excel ne sont pas dans le dépôt.
- 886 termes (801 dans les deux versions, 47 en v5 seulement, 60 nouveaux en v6), 26 catégories (SOC), 1544 libellés de grade distincts.
- Onze termes renommés entre v5 et v6 sont fusionnés en une fiche (table `RENAMED` du script), par exemple « Platelet count decreased » devenu « Thrombocytopenia ».
- Traduction française (04.11.2026, par Claude, **à relire par un médecin**) : noms de termes et définitions de grade. Les définitions de terme NCI restent en anglais. Abréviations : AIVQ, AVQ, LSN, LIN, NPT (légende dans la page).
- Pour régénérer : `python3 -I tools/ctcae/build_ctcae.py v5.xls v6.xls assets/data/ctcae.json` (pandas, xlrd). Le script échoue et liste les libellés sans traduction si le NCI publie une nouvelle version.

## Fonctions
Par défaut : v5.0 et français (décision du 05.11.2026) ; les autres choix sont mémorisés par utilisateur.
Recherche libre tolérante aux accents et aux fautes (1 à 2 lettres), sur noms EN et FR, catégorie et texte des grades ; dictionnaire d'abréviations (ALAT, ASAT, PNN, CRS, QTc, HFS, FEVG…) ; filtre de version (v5.0, v6.0 ou les deux côte à côte avec les grades modifiés surlignés) ; filtre de langue ; filtre de catégorie ; adresse partageable (`?q=&v=&l=&c=`) ; bouton « Copier » par version ; parcours par catégorie quand la recherche est vide.

## Idées non faites
Hors ligne (ajouter `.json` au service worker), relecture et signalement des erreurs de traduction, traduction des définitions de terme, liens depuis Key trials.
