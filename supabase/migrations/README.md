# Absences : durcissement du circuit (11.11.2026)

Version : `202611110001`. Le fichier SQL est transactionnel et réexécutable. Il se place **après** les scripts historiques ; ne pas relancer ensuite les anciennes définitions de fonctions.

## Changements

1. Choix initial des cliniques libre dans Bienvenue ou Mon compte. Les comptes déjà affectés conservent leurs cliniques. Une modification crée une demande ; l'admin ou la direction l'accepte ou la refuse dans Membres et accès. Les cliniques officielles ne changent pas pendant l'attente. Refus commenté, décision unique et contrôle d'une affectation devenue obsolète. Une personne ne décide pas sa propre demande.
2. Lots d'e-mails filtrés par destinataire à la mise en file, puis droits revérifiés avant expédition. Les notifications devenues inutiles sont classées comme ignorées, jamais comme envoyées.
3. Reprises espacées (2, 4, 8, 16 minutes, cinq essais), suivi et relance dans Admin > Absences, traitement périodique indépendant du navigateur. « Envoyé » signifie accepté par le serveur SMTP, pas livraison garantie dans la boîte du destinataire.
4. Journal applicatif append-only des absences, validations et préavis, avec états avant/après et auteur. Conservation des affectations datées ; les tours précédents restent dans le journal lorsqu'un changement ouvre un nouveau tour. Les modifications et annulations directes sont aussi journalisées.
5. Instantanés de documents identifiés `OC-ABS-D…` ; un rectificatif ou une annulation produit une nouvelle version et un nouvel envoi. Les anciens documents restent consultables dans l'historique de l'absence. Le PDF est rendu à partir des données figées ; ce n'est pas un stockage du fichier binaire signé ni une signature qualifiée.
6. Aucun texte libre (précisions, motifs de refus, commentaires) dans les e-mails, pièces jointes et flux iCal. Les informations détaillées restent dans l'application selon les permissions ; les API planning/liste/export/validation masquent les données confidentielles aux validateurs ordinaires. Le détail du journal est réservé à la personne, l'admin et la direction.

Les reprises `BASELINE` et `legacy_snapshot` décrivent l'état présent à l'installation. Elles ne reconstituent pas les anciens tours, rattachements ou documents déjà perdus. L'historique est protégé contre les comptes applicatifs ; un propriétaire de la base reste privilégié.

## Préparation et déploiement

Faire d'abord une sauvegarde Supabase et vérifier sur une base de préproduction disposant du schéma actuel. Les tests locaux chargent les vrais scripts métier dans PostgreSQL embarqué (PGlite) ; les services Auth/Storage et l'horloge sont simulés.

Les prérequis historiques du module sont, dans cet ordre :

- `absences.sql`, `cadre_medecin.sql`, `cadre_validateur.sql`, `absences_validation.sql` ;
- `absences_forms.sql`, `absences_cliniques_datees.sql`, `admin_direction.sql` ;
- `absences_export.sql`, `absences_soldes.sql`, `absences_visibilite.sql`, `absences_preavis.sql` ;
- `absences_vue_ensemble.sql` pour la carte annuelle.

Ils supposent déjà les schémas généraux Onconic/Auth/Storage et les autres fonctionnalités installés. **Sur une base existante, vérifier ces prérequis ; ne pas réexécuter cette liste aveuglément.**

1. Appliquer `202611110001_absence_hardening.sql` sur le projet `icqrobnqvidusajburcu`. Les anciennes fonctions gardent leur signature ; les nouveaux clients doivent venir après la migration.
2. Déployer `notify-absence` avec ses quatre modules (`index.ts`, `message.ts`, `form.ts`, `delivery.ts`). Exemple depuis la racine :

   ```sh
   supabase functions deploy notify-absence --project-ref icqrobnqvidusajburcu --no-verify-jwt
   ```

   La vérification JWT de la passerelle est désactivée pour permettre le worker ; la fonction vérifie elle-même chaque session utilisateur via `auth.getUser`. Le worker n'accepte qu'un secret long et ne donne aucun accès au téléchargement des formulaires. Aucun endpoint de décision n'est exposé par cette Edge Function.
3. Activer `pg_cron`, `pg_net` et Supabase Vault si nécessaire. Créer un secret aléatoire d'au moins 32 caractères, identique dans :
   - les secrets Edge, sous `ABSENCE_WORKER_TOKEN` ;
   - Vault, sous `absence_worker_token`.

   Créer dans Vault `absence_worker_url` avec la valeur non secrète `https://icqrobnqvidusajburcu.supabase.co/functions/v1/notify-absence`. Saisir les valeurs secrètes dans les réglages sécurisés Supabase, jamais dans le dépôt ou un message de chat. Conserver les secrets existants `SMTP_PASSWORD` et `ABSENCE_FORMS_TO`.
4. La migration programme le job `absence-outbox` chaque minute si `pg_cron` est présent. Si l'extension a été activée après la migration, relancer la migration ou programmer le même job. Vérifier `absence_worker_health()` avec une session admin/direction : `scheduled` et `configured` doivent être vrais. Cela atteste de la configuration, pas d'une expédition réussie.
5. Publier les changements HTML/JS via GitHub Pages. Les suffixes des scripts concernés passent à `20261111audit1`.
6. Avec des comptes de test autorisés, vérifier une demande complète, son refus, une modification et une annulation ; contrôler les destinataires effectifs et les PDF. Fermer le navigateur puis vérifier que le job expédie toujours les messages. Tester une erreur SMTP suivie d'une relance. Un lien d'abonnement existant devra se rafraîchir pour retirer les anciennes notes déjà mises en cache par un agenda externe.

Ne pas déclarer la mise en service terminée tant que ces vérifications distantes ne sont pas faites. Le déploiement réel et SMTP n'ont pas été exécutés dans la session de développement.

## Tests reproductibles

Depuis la racine, Node 24 et Python 3 avec Playwright + Chromium :

```sh
npm ci --prefix tests/absences
npm --prefix tests/absences test
npm --prefix tests/absences run check
python3 tests/absences/browser.py
```

`browser.py` démarre et arrête son serveur local. Toutes les requêtes externes du navigateur sont bloquées. Les tests SQL n'envoient aucun e-mail et n'accèdent jamais à la base distante. Ils vérifient notamment les permissions SQL, les deux niveaux et plusieurs validateurs, les refus/changements/retraits, les versions de documents, la confidentialité et les reprises. PGlite utilise une seule connexion : il ne démontre pas les courses de plusieurs connexions PostgreSQL. Les décisions répétées sont testées et les opérations conservent leurs verrous transactionnels.
