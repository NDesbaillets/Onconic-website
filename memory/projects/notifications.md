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
