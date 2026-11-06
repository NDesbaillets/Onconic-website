# Absences (06.11.2026)

**But :** gérer les absences de l'équipe (vacances, congrès, autre), avec validation par des cadres désignés par clinique.

**Fichiers :** `app/absences.html`, `assets/js/absences.js`, `admin/absences.html`, `assets/js/admin-absences.js`, `supabase/absences.sql`, `supabase/functions/notify-absence/` (`index.ts`, `message.ts`), styles `.ab-*` et `.aa-*` dans `assets/css/onconic.css`. Tuile dans l'espace collaboratif de The Hive (outil `absences`, ouvert à médecins, CDC, cadres, assistantes, pharmaciens, admin).

## Rôles et cliniques
- Rôle `cdc` = chef de clinique (médecin ; son rôle Key trials ne change pas). Nouveau rôle `cadre` : valide les absences des cliniques où l'admin le désigne ; accès par défaut limité à l'outil Absences.
- Seuls les médecins (`clinician`, `cdc`) ont des cliniques (`profiles.clinics`, choisies par l'admin dans Membres et accès). Cadre, assistante, pharmacien et admin relèvent de la clinique **Administration** (ajoutée aux 11 cliniques, `absence_clinic_settings`).
- Valideurs : `absence_validators(clinic, user_id)`, réglés par l'admin dans `/admin/absences.html` (un seul valideur suffit). Sans valideur désigné, les demandes vont aux admins, qui valident tout. Nul ne valide ses propres absences (sauf l'admin).

## Fonctionnement
- Tout passe par des fonctions SQL `absence_*` (aucun accès direct aux tables). Statuts : demandée, validée, refusée, annulée. Une absence validée reste telle quelle et affichée pendant une demande de modification ou de suppression ; le valideur accepte ou refuse le changement.
- Planning : toutes les personnes ayant l'outil sont visibles, par défaut celles des cliniques du membre ; choix libre des personnes et du nombre de lignes (préférence gardée dans le navigateur). Motif visible de tous ; précision (note) réservée à l'intéressé et à ses valideurs. Demande = hachuré, validée = plein.
- Avertissement (non bloquant, pour le demandeur et le valideur) : quand, un jour donné, le nombre de membres d'une clinique absents (demandes comprises, demandeur inclus) dépasse le seuil de la clinique (2 par défaut, réglable par l'admin).
- Export Word (`docx` 9.5.1 via jsdelivr) : résumé des absences validées et des demandes en attente ou refusées, par année ; les valideurs l'exportent pour les membres de leurs cliniques.
- Notifications : Web Push (fonction `notify-absence`, abonnements de `push_subscriptions`, case de Mon compte) aux valideurs à chaque demande ou demande de changement, au demandeur à chaque décision ; compteur « n à valider » sur la tuile.

## Limites
- Jours fériés non gérés (jours ouvrables = lundi à vendredi). Pas de soldes de vacances. Pas d'e-mail : seul le push (à activer par appareil) prévient en dehors de The Hive.

## Mise en service (ordre)
1. Exécuter `supabase/absences.sql`.
2. Déployer la fonction `notify-absence` (JWT vérifié).
3. Fusionner la PR, puis dans `/admin/membres.html` : rôle Cadre aux cadres, cliniques aux médecins, et `/admin/absences.html` pour les valideurs.
