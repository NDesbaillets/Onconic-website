# Lettres d'assurance

**Page :** `/app/lettres.html` · **JS :** `assets/js/lettres.js`, `assets/js/letter-parse.js`, `assets/js/lettres-bulk.js` · **SQL :** `supabase/lettres.sql`, `supabase/lettres_bulk.sql`

Les lettres (Word) ne sont jamais dans le dépôt : import par un admin dans la page. Chaque lettre a un texte HTML affiché et copié, le fichier Word d'origine (`docx`, base64) et les médicaments indexés (`drugs` : substance, posologie, nom commercial, firme, code).

## Changement en bloc d'un fournisseur (03.11.2026)
- Admin, section « Changer le nom commercial ou la firme d'une substance (en bloc) ». On tape la substance (recherche par fragment : « pemetrexed »), on choisit l'ancien nom commercial et/ou l'ancienne firme parmi les valeurs détectées, on saisit le nouveau texte, puis **Aperçu** (avant → après par lettre, lettres décochables) et **Appliquer**.
- Le remplacement vise la ligne de la substance dans le tableau « Médicament demandé » (colonne nom commercial + firme) : les autres médicaments d'une même lettre, même de la même firme, ne sont pas touchés. Option : remplacer aussi dans le texte de la lettre (hors tableau).
- Appliqué au texte affiché, aux `drugs` et au fichier Word d'origine (texte coupé en plusieurs morceaux de mise en forme géré). Si le Word n'a pas pu être modifié, la lettre est signalée pour vérification ou réimport.
- La casse est ignorée à la recherche ; le nouveau texte est écrit tel que saisi. Pas d'annulation : refaire le remplacement dans l'autre sens. Journal des 5 derniers changements affiché sous l'outil (`letters_changes`).
- SQL : `letters_patch()` (une lettre), `letters_log_change()`, table `letters_changes`.

## Mise en page liste et lettre (13.11.2026)
Sur ordinateur (≥ 1100 px), la liste et les filtres occupent un tiers de la fenêtre et la lettre choisie s'ouvre sur les deux tiers de droite (copier, télécharger le Word, modifier et supprimer pour l'admin) ; un résultat unique s'ouvre seul, Échap ferme. En dessous, les cartes dépliables d'avant. Module partagé `assets/js/split-view.js` et `assets/css/split-view.css` (utilisé aussi par CTCAE). Test : `node tests/absences/split-view-ui.mjs`.
