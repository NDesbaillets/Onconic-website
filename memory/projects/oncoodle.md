# Oncoodle (sondages de dates et de participation)

**But :** trouver une date pour un événement (colloque, tumor board, repas d'équipe) ou compter les participants, sans passer par un service externe. Alvéole de The Hive, ouverte à **tous les membres validés** (tous rôles sauf « member »), **sans invités externes** (décision du 13.11.2026).

**Fichiers :** `app/oncoodle.html`, `assets/js/oncoodle.js` (page), `assets/js/oncoodle-core.js` (logique pure : jours fériés vaudois, générateur et classement de créneaux, .ics, modèles), `assets/css/oncoodle.css`, `supabase/migrations/202611130002_oncoodle.sql`, `supabase/functions/notify-oncoodle/` (`index.ts`, `message.ts`, `ics.ts`, `delivery.ts`). Tests : `tests/absences/oncoodle*.test.mjs` (SQL, messages, logique pure) et `oncoodle-e2e.mjs` (navigateur contre le vrai SQL).

## Fonctionnement
- **Deux types** : choix de date (2 à 40 créneaux, réponse oui / peut-être / non par créneau) et participation (une date, oui / peut-être / non).
- **Destinataires** : groupes « cliniques ET fonctions » (union des groupes), personnes choisies une à une, exclusions, « tous les membres ». Aperçu du nombre et de la liste avant l'envoi, participants **obligatoires** cochés dans l'aperçu. Liste figée à la création ; le créateur peut ajouter ou retirer des destinataires ensuite. Les infirmier·ères et assistantes n'ont pas de clinique dans la base : ils se choisissent par fonction. Maximum 300 destinataires, 10 sondages par 24 h, 40 ouverts.
- **Conflits** : par créneau, nombre d'invités absents (absences **validées** seulement, filtrées par `absence_can_see`, jamais de nom ni de motif, réservé aux usagers de l'outil Absences) et entrées de l'agenda commun ; jours fériés vaudois calculés dans la page ; absence de l'usager lui-même signalée.
- **Meilleur choix** : obligatoires d'abord (un « non » d'un obligatoire exclut), puis oui = 1 et peut-être = 0,5, puis moins de non, moins d'absents, date.
- **Échéance, relances** : relance manuelle (une par 12 h), relance automatique 48 h avant l'échéance ou 3 jours après la création sans échéance, jamais entre 19 h et 8 h (Zurich). Échéance passée : réponses closes, le créateur est prévenu une fois. « Tout le monde a répondu » : avis unique au créateur.
- **Clôture** : le créateur retient un créneau, message facultatif, e-mail à tous avec fichier .ics (sauf à ceux qui avaient répondu non). Option agenda commun : directement pour admin et direction, sinon proposition envoyée à la boîte de la direction. Réouverture possible. Annulation (avec message) ou suppression (sans message).
- **Visibilité des réponses** : « tous les invités » ou « organisateur seulement » (les autres ne voient que les totaux).
- **Conservation** : sondages clos ou annulés supprimés après 180 jours ; sondages dont le dernier créneau date de plus de 180 jours aussi ; file d'envoi purgée après 90 jours.
- **Données** : aucune table n'est lisible directement (RLS sans règle). Tout passe par les fonctions `oncoodle_*`. Aucun nom ni donnée de patient : avertissement dans le formulaire.
- **Messages** : e-mail (titre, lieu et message de clôture compris) ; push sans aucun texte libre (consentement `notify_events` de Mon compte, texte élargi aux sondages). Les rappels et résumés se désactivent dans Oncoodle (`profiles.oncoodle_email`) ; invitation, date retenue et annulation sont toujours envoyées.

## Mise en service (ordre, règle du 13.11.2026)
1. Projet de test `uubowlcyekbgmizrlyxb` : appliquer `supabase/migrations/202611130002_oncoodle.sql`, requête de contrôle, advisors ; déployer `notify-oncoodle` (`supabase functions deploy notify-oncoodle --project-ref <ref> --no-verify-jwt`, la fonction vérifie elle-même la session ou le jeton Vault).
2. Vault : créer `oncoodle_worker_url` = `https://<ref>.supabase.co/functions/v1/notify-oncoodle` (le secret `absence_worker_token` est réutilisé). La migration programme `oncoodle-outbox` (toutes les 5 min) et `oncoodle-tick` (toutes les 30 min) si `pg_cron` est présent ; `oncoodle_worker_health()` (admin) doit répondre `scheduled` et `configured` vrais. Les secrets `SMTP_PASSWORD` et `ABSENCE_FORMS_TO` existent déjà.
3. Validation de Nicolas sur l'aperçu Cloudflare, puis feu vert explicite pour la production `icqrobnqvidusajburcu` (sauvegarde du jour d'abord).
4. Réexécution possible de la migration sans risque. Aucune entrée dans `tool_access` pour Oncoodle n'est gérée par l'administration (outil ouvert à tous) ; une exception reste possible en SQL.

## Limites connues
- Pas d'invités sans compte, pas de fuseau autre que Zurich, pas de sondage récurrent.
- Les absences d'invités ne sont comptées que si l'usager peut voir ces personnes dans Absences : le total peut être inférieur à la réalité.
- Les envois réels (SMTP, push, cron, Vault) n'ont pas été exécutés dans la session de développement : à vérifier sur le projet de test.
