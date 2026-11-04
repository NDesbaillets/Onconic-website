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
`tools/formation/pptx2html.py` (python-pptx) reproduit chaque diapositive du PPTX à l'identique (formes, tableaux, images, graphiques en colonnes, schémas) dans une scène 960×540 mise à l'échelle ; le texte reste sélectionnable et indexé. Les notes du présentateur ne sont pas reprises. Premier recueil converti le 04.11.2026 : « Gliomes de grade 3 et 4 » (28 diapositives, 4,3 Mo).

## Idées non faites
Liens vers les fiches Key trials, recherche par diapositive isolée, hors ligne (PWA), accès par CDC de la clinique, circuit de validation et signalement « à réviser ».
