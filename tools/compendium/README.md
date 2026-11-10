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

## Mise à jour automatique (2 fois par mois)
Une tâche programmée (1er et 15 du mois) exécute :
1. `aips_rx.py download DOSSIER` : télécharge le fichier AIPS et retourne le chemin du XML (le fichier est régénéré chaque jour, d'où l'étape suivante).
2. `aips_rx.py check XML --state tools/compendium/state.json` : compare l'empreinte des RCP suivis (URL des documents, qui changent à chaque nouvelle version) à celle du dernier run. Code de sortie 0 = rien de nouveau, 10 = au moins un RCP a changé.
3. Si changement : `build XML --cache DOSSIER --sql supabase/sl_rx_auto.sql --report rapport.md --state tools/compendium/state.json`, qui régénère le SQL, liste les changements de dosages et de posologies, et met à jour `state.json`.
4. PR, merge, puis exécution du SQL (relançable : jamais de texte existant écrasé, validé ou non ; une variante n'est créée que si aucun texte n'existe déjà pour cette présentation et cette dose).
Les textes déjà validés dont le RCP a changé ne sont pas modifiés : ils sont listés dans le compte rendu pour relecture.
