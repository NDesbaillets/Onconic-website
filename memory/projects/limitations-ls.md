# Limitations LS (Liste des spécialités OFSP)

**Page :** `/app/limitations.html` · **JS :** `assets/js/limitations.js`, `assets/js/sl-parse.js` · **SQL :** `supabase/sl.sql`, `supabase/sl_rx_seed.sql`

## Principe (01.11.2026)
- Médecins validés (clinician, admin) ; pas de restriction CHUV (la LS est publique).
- Import admin en bas de page : export Excel OFSP en français, onglets « Données de base » et « Limitations », colonnes repérées par en-tête (format repris de l'ancien outil d'initiation, PR #15). Classes ATC gardées : L01, L02, L03, L04AX, M05B, A04AD, V03AF. Remplacement atomique (`sl_replace`) et calcul des changements vs import précédent (`sl_changes`), affichés aux médecins.
- Recherche : un ou plusieurs médicaments (DCI français ou latin, nom commercial), clinique et type de cancer (expressions dans `CANCERS`) pour classer les limitations ; code d'indication en évidence avec copie ; badges « garantie préalable » et « limité au ». Sans limitation : message simple. Introuvable : renvoi vers Lettres d'assurance (art. 71a-d OAMal).
- Per os : texte d'ordonnance « ligne produit / S. posologie / Code d'indication : … » et tableau des paliers de dose. Table `sl_rx` : brouillon invisible des médecins jusqu'à validation admin (éditeur dans la page).
- 48 brouillons préparés depuis les RCP (thoracique, mélanome, sein, urologie, GI, neuro) : à relire et valider par Nicolas.

- Panier d'ordonnance (01.11.2026) : ajout des textes per os (code d'indication obligatoire si limitation), réordonner, retirer, « Copier tout » ; conservé dans sessionStorage de l'onglet. Autres pistes (alerte d'échéance, lien Key trials, traitements de support, interactions) écartées par Nicolas pour l'instant.

## Points ouverts
- Fichier Excel réel de Nicolas non reçu dans la session : tester l'import dès le premier dépôt.
- Valider les 48 textes d'ordonnance ; compléter les substances per os sans texte (liste affichée à l'admin).

## Posologie selon l'indication (03.11.2026)
- Une même ligne produit peut avoir plusieurs textes `sl_rx`, un par indication (colonnes `indication` et `indication_match`, voir `supabase/sl_rx_indication.sql`). Chaque texte garde sa posologie, ses paliers, sa remarque et sa validation.
- Génération : s'il y a plusieurs textes pour la ligne produit, un sélecteur « Indication » apparaît. Présélection si un seul texte correspond (mots-clés cherchés dans la limitation choisie et le type de cancer), sinon **choix obligatoire** : sans choix, la dose n'est pas affichée et la copie et le panier sont bloqués. Alerte si l'indication choisie ne correspond pas à la limitation sélectionnée.
- Panier : une seule ligne par présentation, quelle que soit l'indication ; l'indication est rappelée dans le panier.
- Éditeur admin : champs Indication et Mots-clés, bouton « Dupliquer pour une autre indication », refus des doublons.
- Aucune donnée de dosage par indication n'est préremplie : les variantes sont à saisir (ou à préparer depuis les RCP, à valider par un médecin).
