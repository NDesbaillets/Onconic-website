# Key trials

**Page :** `/app/trials.html` · **JS :** `assets/js/trials.js` · **SQL :** `supabase/trials.sql`
**Source des fiches :** générées par script (hors dépôt) ; le SQL contient les 14 fiches en JSON.

## Contenu d'une fiche
Schéma de l'étude (SVG : population et critères d'inclusion → randomisation → bras → critères), section « Traitements de l'étude » (doses, voie, schéma, durée, bouton copier), courbes PFS/OS, forest plot des HR, tableau, tolérance, discussion (forces, limites, practice changing), références PubMed/DOI.

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
