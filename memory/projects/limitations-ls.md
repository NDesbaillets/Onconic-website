# Limitations LS (Liste des spécialités OFSP)

**Page :** `/app/limitations.html` · **JS :** `assets/js/limitations.js`, `assets/js/sl-parse.js` · **SQL :** `supabase/sl.sql`, `supabase/sl_rx_seed.sql`

## Principe (01.11.2026)
- Médecins validés (clinician, admin) ; pas de restriction CHUV (la LS est publique).
- Import admin en bas de page : export Excel OFSP en français, onglets « Données de base » et « Limitations », colonnes repérées par en-tête (format repris de l'ancien outil d'initiation, PR #15). Classes ATC gardées : L01, L02, L03, L04AX, M05B, A04AD, V03AF. Remplacement atomique (`sl_replace`) et calcul des changements vs import précédent (`sl_changes`), affichés aux médecins.
- Recherche : un ou plusieurs médicaments (DCI français ou latin, nom commercial), clinique et type de cancer (expressions dans `CANCERS`) pour classer les limitations ; code d'indication en évidence avec copie ; badges « garantie préalable » et « limité au ». Sans limitation : message simple. Introuvable : renvoi vers Lettres d'assurance (art. 71a-d OAMal).
- Per os : texte d'ordonnance « ligne produit / S. posologie / Code d'indication : … » et tableau des paliers de dose. Table `sl_rx` : brouillon invisible des médecins jusqu'à validation admin (éditeur dans la page).
- 48 brouillons préparés depuis les RCP (thoracique, mélanome, sein, urologie, GI, neuro) : à relire et valider par Nicolas.

## Points ouverts
- Fichier Excel réel de Nicolas non reçu dans la session : tester l'import dès le premier dépôt.
- Valider les 48 textes d'ordonnance ; compléter les substances per os sans texte (liste affichée à l'admin).
