# Extraction des courbes de survie (Key trials)

Lit les courbes de Kaplan-Meier directement dans le PDF d'une publication et produit l'objet
`km` d'une fiche Key trials. Les PDF viennent de la bibliothèque Zotero de Nicolas (accès CHUV) ;
**aucun PDF ne se commite** (droits d'auteur, dépôt public).

Dépendances : `pdfplumber`, `numpy`, `Pillow` (déjà présents dans l'environnement des sessions Claude).

## Chaîne complète

1. **PDF depuis Zotero.** Utilisateur `22512740`, collection `KeyTrials-queue` (clé `XTGEQGYX`).
   La clé API est injectée par le proxy de l'environnement : aucun en-tête d'authentification à ajouter.
   Chaque article porte le tag `KT:<nom de l'étude>` et son PMID dans le champ Extra (`PMID: …`).
   ```
   curl -sS -H 'Zotero-API-Version: 3' 'https://api.zotero.org/users/22512740/collections/XTGEQGYX/items?limit=100'
   curl -sS -L -o f.pdf 'https://api.zotero.org/users/22512740/items/<clé de la pièce jointe PDF>/file'
   pdftotext -layout f.pdf f.txt        # texte intégral : méthodes, doses, tableaux, tolérance
   ```
2. **Repérer les panneaux** : `python3 tools/km/kmextract.py probe f.pdf` affiche, pour chaque tracé
   coloré, la page, le panneau, la médiane et la survie à 12, 24, 36 et 60 mois.
3. **Comparer au texte** : médiane à ±0,5 mois et taux publiés à ±2 points, sinon ne pas enregistrer la
   courbe (`km` vide) et le dire dans `design.sources_note`.
4. **Générer l'objet `km`** (JSON sur la sortie standard) :
   ```
   python3 tools/km/kmextract.py item f.pdf --page 6 --panel 0 \
     --colors '0.65,0.4,0.0,0.02;0.0,0.75,0.75,0.2' --names 'Osimertinib;Gefitinib/erlotinib' \
     --ep PFS --hr 'HR 0,46 (0,37–0,57)' --label 'Survie sans progression' \
     --source 'Figure 1A, Soria N Engl J Med 2018 (digitalisée depuis le PDF)' --xmax 27
   ```
   Les couleurs sont celles données par `probe` ; associer chaque couleur à son bras d'après la médiane
   (elles changent d'un article à l'autre). Les effectifs à risque sont lus sous l'axe (`--no-atrisk`
   pour les omettre ; `--atrisk-step` pour le pas des graduations).

## Méthodes

| Méthode | Quand | Commande |
|---|---|---|
| `axes` (défaut) | axes dessinés par des traits (NEJM, JCO, Lancet Oncol, la plupart) | `item` |
| `free` | pas de traits d'axes (Nat Med, Lancet Respir Med, Lancet) | `item --method free` |
| `rot` | figure pivotée de 90° (texte inversé, temps en vertical) | `rot --px0 … --px1 … --y0 … --y1 … --tmax …` |
| `raster` | figure en image (manuscrits PMC) ; précision moindre | `raster img.png --crop x0,y0,x1,y1 --xmax 27 --colors '200,30,30;30,60,200'` |

## Pièges rencontrés

- **Figure pivotée** : lire les objets `curves`, pas les `lines` (les `lines` contiennent les marques de
  censure et donnent des courbes fausses).
- **Calibration** : les axes sont calés sur les petits traits de graduation, pas sur le centre des
  étiquettes (décalage de 0,3 point de survie, soit 0,6 mois sur une courbe plate près de 50 %).
- **Étiquettes parasites** : un « 0 » de l'axe X peut se retrouver dans l'axe Y ; les étiquettes Y sont
  filtrées sur leur bord droit commun.
- **Axe Y en 0-1 ou 0-100** : détecté automatiquement.
- **Colonne de droite sans graduations Y** : celles du panneau voisin sont reprises.
- **Courbe plate près de 50 %** : la médiane est sensible à ±0,3 point ; vérifier aussi les taux publiés.
- **Même bras dans deux panneaux** (ex. bras chimiothérapie commun) : les courbes doivent coïncider ;
  sinon garder celle du panneau le plus précis.
- **Raster** : médianes à ±0,5 mois ; enregistrer les médianes publiées et le dire dans `sources_note`.

## Tests

```
python3 -m unittest discover -s tools/km -p 'test_*.py' -v
```
Figure synthétique (reportlab) et image synthétique ; aucun PDF d'éditeur dans le dépôt.
