# Planning administratif

**État :** V1 développée le 16.11.2026 : `/app/planning.html`, migration `202611160003_planning_admin.sql`, tests `tests/absences/planning.test.mjs`. Elle est appliquée au projet de test ; la production attend le feu vert. La maquette d'origine reste sur la branche `maquette-planning` (non fusionnée).

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

## Comptes temporaires (en place depuis le 16.11.2026, PR « comptes temporaires »)
- **Migration** `202611160002_comptes_temporaires.sql`. Nouvelles colonnes dans `profiles` : `admin_lead`, `access_until` (dernier jour inclus, heure suisse) et `created_by`. Journal `temp_account_log`.
- **Fonction « cadre administratif »** : case à cocher dans `/admin/membres.html`, sur une assistante permanente. Elle donne l'outil `temporaires`, page `/app/temporaires.html`. La tuile The Hive n'apparaît qu'aux cadres administratifs, à la direction et à l'admin.
- **Création** : Edge Function `temp-account`. Le compte est créé au rôle assistant, avec l'institution CHUV, actif tout de suite et sans validation par l'admin. Fin d'accès dans un an au plus. Deux modes :
  - invitation par e-mail : la personne choisit son mot de passe ;
  - mot de passe provisoire, affiché une seule fois au cadre.
- **Gestion** : le cadre administratif prolonge, raccourcit, termine ou réactive un compte temporaire avec `temp_account_set_until`. Il n'agit sur aucun compte permanent.
- **Fin d'accès** :
  - dès le lendemain du dernier jour, `current_role_name()` rend « member » et `tool_allowed()` refuse tout ;
  - la connexion est bloquée (`banned_until`) par `temp_accounts_expire()`, à l'ouverture de la page et chaque nuit en production (`supabase/temp_accounts_cron.sql`, production seulement).
- **Administration** : la direction et l'admin peuvent limiter dans le temps n'importe quel compte non admin ou lever la limite (`admin_set_access_until`).
- **Tests** : `tests/absences/temp-accounts.test.mjs` (PGlite). Parcours complet vérifié sur le projet de test le 16.11.2026. L'invitation par e-mail ne part pas depuis le projet de test, qui n'envoie pas d'e-mails.

## V1 (16.11.2026)
- **Tables** : `plan_staff` (effectif, lien facultatif `user_id`, semaine type, jours off, période pour les temporaires), `plan_codes` (catalogue, groupe, couleurs, absence, « privé », actif), `plan_cells` (personne, jour, demi-journée) et `plan_settings` (lignes de couverture et minimums). La RLS est activée sans accès direct : tout passe par les fonctions.
- **Fonctions** :
  - `plan_grid(from, to)` : lecture (400 jours au plus) ;
  - `plan_set_cells(jsonb)` : écriture par lot (jours ouvrables, période de présence, code connu) ;
  - `plan_staff_save`, `plan_code_save` et `plan_coverage_save` ;
  - `plan_accounts` : comptes qu'on peut relier à une ligne ;
  - `can_edit_planning()` : cadres administratifs, admin et direction.
- **Outil `planning`** (`tool_allowed`) : lecture pour tous les membres CHUV validés (médecins, assistantes, infirmier·ères, pharmaciens, direction, admin). Les cadres administratifs l'ont toujours.
- **Masquage** : les codes « privés » (ML, CA, MIL) apparaissent « ABS » pour les lecteurs, sauf sur leur propre ligne (compte relié).
- **Page** :
  - périodes : semaine, 2 semaines, mois, fenêtre glissante (4 ou 6 semaines, 3 ou 6 mois) ;
  - pinceau, rectangle, gomme, annulation ; enregistrement par lot ;
  - fiche (semaine type, absence sur une période, compte relié) ;
  - copie de semaine ; catalogue modifiable ; couverture ;
  - export Excel au format du tableur, avec la couverture et la légende ;
  - import du tableur : lu dans le navigateur, sans doublon si relancé. Les codes inconnus vont dans le groupe « À définir », avec la couleur de la case et le libellé de la 2e feuille.
- **Jours fériés vaudois** : calculés dans le navigateur, comme dans Absences.
- **Plus tard (V2/V3)** : lien avec l'app Absences, abonnement agenda « Mon planning », historique des modifications.
