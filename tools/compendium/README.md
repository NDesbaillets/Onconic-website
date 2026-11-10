# Compendium : dosages et posologies par indication (Limitations LS)

Remplit `public.sl_rx` pour les médicaments per os à partir des RCP du Compendium (fichier AIPS de Swissmedic / Refdata).

## Principe
1. Télécharger le fichier AIPS sur <https://download.swissmedicinfo.ch/> (accepter les conditions d'utilisation Refdata). Le zip contient un XML qui ne liste que les URL des RCP (HTML) ; ne pas le commiter.
2. `python3 tools/compendium/aips_rx.py build AipsDownload_AAAAMMJJ.xml --cache /chemin/cache --sql supabase/sl_rx_auto.sql --report /chemin/rapport.md`
   - sélectionne les RCP humains en français des substances de `substances.json` (nom commercial ou DCI dans l'intitulé, indications oncologiques) ;
   - télécharge leur HTML (cache local, aucune donnée patient) ;
   - extrait les **dosages disponibles** (rubriques « Forme pharmaceutique… » et « Présentation ») et la **posologie recommandée par sous-titre** de la rubrique « Posologie » ;
   - écrit `supabase/sl_rx_auto.sql`.
3. Exécuter le SQL (après `sl.sql` et `sl_rx_indication.sql`). Relançable sans risque : seule la colonne `strengths` est réécrite ; les textes existants ne sont jamais modifiés, hors ajout de l'indication à un brouillon dont la dose correspond.

## Ce qui est automatique
- Colonne `sl_rx.strengths` : dosages par forme, affichés sous le tableau des paliers.
- Une posologie par régime distinct (dose, fréquence) du RCP : brouillon `sl_rx` avec `indication` (sous-titre du RCP) et `indication_match` (synonymes LS et médicament partenaire).
- Une présentation par forme orale solide (comprimé, capsule) de l'adulte.
- Régimes en mg/m² : brouillon avec la mention « dose en mg à calculer ».

## Limites (d'où la validation par un admin)
- Les régimes de titration (brigatinib), au poids (selpercatinib) ou à cycles évolutifs (témozolomide : `no_variants`) ne sont pas dérivés ; les textes préparés à la main restent la référence.
- Les paliers de réduction ne sont pas extraits : un brouillon créé n'a que la dose initiale.
- Substances sans RCP trouvé (nom commercial absent de `substances.json`) : signalées à l'exécution.
