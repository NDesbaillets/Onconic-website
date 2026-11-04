# Formation

**Page :** `/app/formation.html` · **JS :** `assets/js/formation.js` · **SQL :** `supabase/formation.sql` · **Visionneuse isolée :** `app/formation-viewer.html` · **Modèle de recueil :** `assets/formation/deck-template.html`

Outil « formation » (`has_tool('formation')`) : médecins, CDC, assistantes, pharmaciens (admin toujours). Dépôt, modification, suppression : **admin seulement** (décision du 04.11.2026).

## Contenu
Recueil = un fichier **HTML autonome** (diaporama) ou un **PDF**, classé par clinique (les 11 cliniques de Key trials) puis pathologie. Fiche : titre, pathologie, mots-clés, niveau (résidents, cadres, tous), auteur, résumé, statut brouillon (visible de l'admin seul) ou publié, fichier source PowerPoint facultatif (téléchargeable). Case obligatoire « aucune donnée de patient ».

## Stockage et sécurité
- Fichiers dans le bucket privé `formation` (jamais dans le dépôt Git, public) ; lecture réservée aux membres de l'outil et aux recueils publiés (policies sur `storage.objects`).
- Un recueil HTML s'affiche dans `formation-viewer.html`, chargé dans un iframe `sandbox="allow-scripts"` (origine opaque : pas d'accès à la session ni à localStorage) avec une CSP sans réseau (`default-src 'none'`). Le recueil doit être autonome (images en data:, pas de script ni de style externe) ; le dépôt avertit si des ressources externes sont détectées. Vérifié par test : parent, localStorage et réseau bloqués.
- PDF : affichage par blob dans un iframe + bouton « Ouvrir dans un onglet ».

## Recherche
Texte intégral. À l'enregistrement, l'application extrait le texte (HTML : une entrée par `<section class="slide" data-title="…">` ; PDF : une entrée par page, via pdf.js chargé depuis jsDelivr) et stocke `slides` (jsonb) et `search_norm` (minuscules, sans accents). `trainings_search(p_terms)` renvoie les recueils contenant tous les termes et la première diapositive ou page concernée ; un clic ouvre le recueil à cette diapositive (message `goto` au recueil ; le modèle le gère).

## Produire un recueil
Partir de `assets/formation/deck-template.html` (diapositives en `<section class="slide" data-title="…">`, navigation clavier et tactile, plein écran, impression PDF). Le demander à Claude à partir d'un contenu ou d'articles.

## Convertir un PowerPoint en recueil HTML
- **`tools/formation/pptx2onconic.py`** (par défaut, décision du 04.11.2026) : extrait le contenu du PowerPoint (texte, tableaux, images, graphiques en colonnes) et le remet en page au **style Onconic** : Helvetica Neue, titres légers avec filet ambre, eyebrow en capitales, cartes à bord supérieur, tableaux et encadrés navy, palette navy et ambre, logo en pied de page. La disposition est reconstruite par découpage XY (colonnes, lignes) d'après les positions du PowerPoint ; un ajustement automatique réduit une diapositive trop dense (images d'abord, texte ensuite). Les schémas à connecteurs (arbre, plan d'étude) sont conservés tels quels mais recolorés. Les couleurs sont ramenées à la palette Onconic (bleu vif du modèle remplacé par l'ambre). Les pieds de page sont générés en CSS pour ne pas polluer la recherche.
- `tools/formation/pptx2html.py` : reproduction fidèle (positions, couleurs et polices du PowerPoint), pour un export identique.
- Aucun des deux ne reprend les notes du présentateur. Dépendances : python-pptx, lxml.
- Premier recueil converti le 04.11.2026 : « Gliomes de grade 3 et 4 » (28 diapositives, 4,3 Mo).

## Idées non faites
Liens vers les fiches Key trials, recherche par diapositive isolée, hors ligne (PWA), accès par CDC de la clinique, circuit de validation et signalement « à réviser ».
