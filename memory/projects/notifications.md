# Notifications push (congrès)

**But :** prévenir un membre quand un autre membre de The Hive indique qu'il participe à un congrès où il participe aussi.

**Fichiers :** `supabase/push.sql`, `supabase/functions/notify-event-join/` (`index.ts`, `message.ts`), carte « Notifications » dans `app/account.html` et `fr/app/compte.html`, logique dans `assets/js/account.js`, déclenchement dans `assets/js/congres.js` (`setStatus`), réception dans `sw.js`.

## Fonctionnement
- Réglage **par appareil** dans Mon compte : la case demande l'autorisation au navigateur, abonne l'appareil (Web Push) et enregistre `profiles.notify_events = true`. Décocher supprime l'abonnement de l'appareil ; le consentement du compte est retiré quand plus aucun appareil n'est abonné.
- Quand un membre passe à « Je participe » ou « Je présente » sur la page Congrès, la page appelle la fonction `notify-event-join`. Elle relit la participation en base, n'annonce qu'**une fois par membre et par événement** (`event_join_notices`), puis envoie aux autres participants qui ont `notify_events = true`.
- Le nom n'est donné que si le membre qui rejoint a accepté de l'afficher (`show_in_events`) ; sinon « Un autre membre de The Hive ». Texte en français ou en anglais selon `profiles.lang` du destinataire.
- Les clés VAPID sont créées par la fonction au premier appel et stockées dans `public.push_config` (lisible par la fonction seule). Supprimer cette ligne régénère les clés : chaque appareil doit alors réactiver les notifications.
- Abonnements expirés (404/410) supprimés automatiquement.

## Limites
- iPhone/iPad : il faut d'abord installer l'app (Partager, « Sur l'écran d'accueil »), iOS 16.4 ou plus.
- L'abonnement reste lié au dernier membre qui l'a activé sur cet appareil, même après déconnexion : à décocher dans Mon compte sur un appareil partagé.
- Seuls les statuts « Je participe » et « Je présente » déclenchent une annonce, pas « Peut-être ».

## Mise en service (ordre)
1. Exécuter `supabase/push.sql` (colonne, tables, fonction `push_subscribe`).
2. Déployer la fonction `notify-event-join` (JWT vérifié).
3. Fusionner la PR (le site lit `profiles.notify_events` et appelle la fonction).


## Réglages par type et par canal (14.11.2026)
Chaque membre choisit, dans **Mon compte > Notifications**, ce qu'il reçoit par **e-mail** et par **notification sur l'appareil**, type par type (`assets/js/notify-prefs.js`, `assets/css/notify-prefs.css`, conteneur `#notify-prefs` dans `app/account.html` et `fr/app/compte.html`). Tout est activé par défaut : sans réglage enregistré, rien ne change.
- **Types** (`supabase/migrations/202611140002_notification_prefs.sql`, colonne `profiles.notif_prefs`) : `to_validate` (nouvelle demande), `to_validate_change` (modification ou suppression d'une absence validée), `reminder` (rappels), `to_direction` (visa), `to_opinion` (pré-avis), `approved`, `rejected`, `change_approved`, `change_rejected`, `direction_change` (décisions sur ses propres absences), `event_join` (congrès, notification seulement). La base ne propose que les types qui concernent le membre : demandes à valider pour un admin ou un·e valideur·se désigné·e, direction pour direction et admin, « mes absences » pour qui a l'outil Absences, congrès pour qui a l'outil Congrès.
- **Rappels** : un rappel part seulement si son type de base **et** « Rappels » sont activés.
- **Envoi** : `notify-absence` et `notify-event-join` lisent `notif_prefs` (`prefs.ts`, fonction `wants`). Un message entièrement coupé est classé « ignoré » dans la file, jamais « envoyé ». Un push seul (e-mail coupé) termine la ligne normalement.
- **Direction** : ses messages partent vers la boîte commune (`ABSENCE_FORMS_TO`), un seul e-mail par message ; il part tant qu'au moins un·e destinataire du message le souhaite, et plus du tout si tous l'ont coupé.
- **Non réglables** : les envois à la boîte de gestion (formulaires PDF), les invitations, dates retenues et annulations d'Oncoodle (les rappels et résumés d'Oncoodle se règlent dans Oncoodle). Les demandes restent toujours visibles dans l'application.
- **Droits** : la colonne n'est modifiable que par `my_set_notification_pref`, `my_reset_notification_prefs` ; lecture par `my_notification_prefs`.
- **Tests** : `notification-prefs.test.mjs` (SQL et fonction pure), `endpoint-prefs.test.mjs` (gestionnaire complet, e-mail et push simulés), `notify-prefs-ui.mjs` (navigateur).
