# Congrès : présentation, retours, abonnement agenda

**Fichiers :** `supabase/congres_plus.sql`, `supabase/functions/calendar-feed/` (`index.ts`, `ics.ts`), page `app/congres.html`, logique dans `assets/js/congres.js`, styles `.cg-talk`, `.cg-note`, `.cg-subscribe` dans `onconic.css`.

## Détail de la présentation
Quand le statut est « Je présente », le membre peut saisir titre, type (oral, poster, invité, table ronde), date et heure (colonnes `talk_*` de `event_participants`). Les autres membres les voient via `event_talks()`, seulement si le membre a accepté d'afficher son nom (`show_in_events`). La présentation apparaît dans l'agenda du membre.

## Retours de congrès
Table `event_takeaways` : un retour par membre et par événement (10 à 1200 caractères, lien facultatif vers une fiche Key trials). Écriture réservée aux participants, à partir du premier jour de l'événement (règle RLS). Lecture par tous les membres avec accès Congrès via `event_takeaways_list()` ; le nom n'apparaît que si `show_in_events`, sinon « Un membre ». L'auteur modifie ou supprime ; un admin peut supprimer (modération). Aucune donnée de patient.

## Abonnement agenda
Lien privé `.../functions/v1/calendar-feed?t=<jeton 64 caractères>`. Jeton dans `calendar_tokens` (créé par `calendar_token()`, renouvelable : l'ancien lien cesse de fonctionner). La fonction `calendar-feed` (sans JWT, car les agendas ne savent pas en envoyer) lit `calendar_feed(jeton)`, réservée au rôle service : événements où le membre participe (« Peut-être » = provisoire), échéances (abstracts, tarif réduit) avec rappel 3 jours avant à 9 h, présentations avec date et heure. Rafraîchissement annoncé toutes les 6 h (Google : jusqu'à 24 h).

## Mise en service (ordre)
1. Exécuter `supabase/congres_plus.sql`.
2. Déployer `calendar-feed` (sans vérification de JWT).
3. Fusionner la PR.

## Limites
- Un jeton divulgué donne accès en lecture à l'agenda du membre jusqu'à son renouvellement.
- Les heures de présentation sont « flottantes » (heure locale du lieu, sans fuseau).
- Un membre dont l'accès Congrès est retiré voit son flux se vider.
