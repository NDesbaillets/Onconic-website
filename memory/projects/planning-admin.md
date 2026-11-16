# Planning administratif

**État :** maquette cliquable (16.11.2026), branche `maquette-planning`, aperçu `maquette-planning.onconic.pages.dev/app/planning-maquette`. Données fictives, aucun appel au serveur. Cette branche ne se fusionne pas.

Le but est de remplacer le tableur Excel des cadres administratifs : une ligne par collaborateur·rice, deux colonnes par jour ouvrable (matin, après-midi), un code couleur par poste. Le tableur réel contient de vrais noms : il ne va jamais dans le dépôt.

## Codes (légende du tableur)
- Postes par bloc 1, 2 et 3 : AM, SEC, SA et TT (bloc 1 rose, bloc 2 bleu, bloc 3 orange). SEC0 et SA0 sont attribués selon les besoins.
- Desk et accueil : DA1 (7h30-16h30), DA2 (8h00-17h00), UTI.
- Back office : BO1 (référent), BO2 à BO4, BOD.
- Encadrement : CU, AD, TTC, INT.
- Absences : V, ML, CA, FOR, MIL.
- **Codes à faire définir par les cadres admin** (présents dans le tableur, absents de la légende) : SC, S-MC, CUS, TT, RDV1 à RDV3, ENCAD, ONM.

## Fonctions de la maquette
- **Saisie** :
  - pinceau (clic ou glisser), Maj + clic pour un rectangle, gomme, annulation ;
  - semaine type par personne, appliquée sur une période ;
  - absence sur une période ;
  - copie d'une semaine sur les N suivantes.
- **Affichage** : semaine, 2 semaines, mois, fenêtre glissante (4 ou 6 semaines, 3 ou 6 mois). Jours fériés vaudois et jours off en gris.
- **Couverture** : compteurs par poste et par demi-journée, avec des minimums réglables.
- **Effectif** : ajout et modification de lignes (taux, bloc, jours off, responsable, statut fixe ou temporaire, dates de mission, accès à Onconic). Hors de ses dates, une ligne est hachurée et ne compte pas.
- **Vues** :
  - cadre admin : édition ;
  - admin : lecture seule, sa propre ligne surlignée ;
  - médecin : lecture seule.
  - Les motifs ML, CA et MIL ne sont visibles que des cadres admin et de la personne elle-même.
- **Export Excel** au format du tableur, avec un onglet Légende et un récapitulatif de couverture.

## Décisions (16.11.2026)
- **Droits** : une nouvelle fonction « cadre administratif », drapeau sur le rôle assistant (comme le validateur des absences), qui donne l'édition du planning. Les autres admins et les médecins voient le planning en lecture seule.
- **Lignes et comptes** : une ligne du planning n'est pas un compte Onconic. Le lien avec un compte est facultatif ; il permettra, dans un deuxième temps, de relier le planning à l'app Absences.
- **Compte générique « Temporaires »** : il est gardé pour l'instant. Il a les mêmes outils que les autres admins. Son mot de passe est géré par les cadres admin.
- **Plus tard** : un compte individuel par temporaire, limité dans le temps. Le cadre admin le crée lui-même, avant l'engagement, sans validation par l'administrateur.

## À prévoir pour la vraie version
- **Mot de passe du compte générique**
  - Un cadre admin ne peut pas changer le mot de passe d'un autre compte depuis le navigateur. Il faut une Edge Function (`auth.admin`), réservée aux cadres admin et limitée à ce seul compte.
  - L'adresse e-mail du compte générique doit être une boîte tenue par les cadres admin. Avec le « changement de mot de passe sécurisé » de Supabase Auth, un temporaire ne peut pas alors changer le mot de passe lui-même.
- **Comptes temporaires individuels**
  - Une Edge Function crée un compte déjà validé, au rôle assistant uniquement, avec une date de fin d'accès (`access_until`).
  - L'accès est refusé après cette date dans les fonctions d'accès, et une tâche nocturne désactive le compte (production uniquement).
- **Import du tableur 2026** directement dans le navigateur : effectif, codes et planning déjà saisi.
