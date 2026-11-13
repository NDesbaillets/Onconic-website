# Sauvegardes Onconic

Trois niveaux :

1. **Supabase Pro** : sauvegarde quotidienne automatique, 7 jours, restaurable depuis le tableau de bord (Database > Backups).
2. **Sauvegarde nocturne externe** : workflow `.github/workflows/sauvegarde-nocturne.yml`. Chaque nuit, base (rôles, schéma, données) et fichiers Storage, archivés puis chiffrés avec `age`, envoyés sur Infomaniak Swiss Backup. 35 jours de quotidiennes, 13 mois de mensuelles (copie du 1er du mois).
3. **Hors sauvegarde**, à noter dans le gestionnaire de mots de passe : secrets des Edge Functions (SMTP, `ABSENCE_FORMS_TO`, `ABSENCE_WORKER_TOKEN`), secret Vault `absence_worker_token`, clés VAPID, clé privée `age`, identifiants Swiss Backup.

Le dépôt est public : aucune archive, aucun dump et aucune clé privée ne doit y entrer. Les journaux GitHub Actions sont publics ; le workflow n'affiche que des tailles et des nombres de fichiers.

## Mise en place (une seule fois)

### 1. Clé de chiffrement `age`

À faire sur ton ordinateur, jamais dans une session Claude :

```sh
brew install age                 # Mac (Homebrew)
age-keygen -o onconic-backup.key
```

La commande affiche `Public key: age1…`.

- Le fichier `onconic-backup.key` (ligne `AGE-SECRET-KEY-…`) va **entièrement** dans le gestionnaire de mots de passe, puis le fichier est supprimé de l'ordinateur. Sans cette clé, les sauvegardes sont illisibles, y compris pour nous.
- La clé publique `age1…` n'est pas secrète : elle va dans une variable GitHub (étape 4).

### 2. Swiss Backup

Appareil de type stockage cloud, protocole S3. Noter l'endpoint, la région, l'access key et la secret key. Créer un compartiment `onconic-backups` si l'interface le demande.

### 3. Supabase

- **Connexion à la base** : Connect > Connection string > **Session pooler** (pas « Direct connection », inaccessible depuis GitHub en IPv4). Copier l'URI et y remplacer `[YOUR-PASSWORD]` par le mot de passe de la base (Project Settings > Database > Reset database password si inconnu).
- **Clés S3 du Storage** : Storage > S3 Configuration (ou Settings > Storage) > New access key. Ces clés donnent un accès complet au Storage : secret uniquement.

### 4. GitHub

Dépôt > Settings > Secrets and variables > Actions.

Onglet **Secrets** :

| Nom | Valeur |
|---|---|
| `SUPABASE_DB_URL` | URI du session pooler, mot de passe inclus |
| `SUPABASE_STORAGE_ACCESS_KEY` | Access key S3 du Storage |
| `SUPABASE_STORAGE_SECRET_KEY` | Secret key S3 du Storage |
| `SWISS_BACKUP_ACCESS_KEY` | Access key Swiss Backup |
| `SWISS_BACKUP_SECRET_KEY` | Secret key Swiss Backup |

Onglet **Variables** :

| Nom | Valeur |
|---|---|
| `SWISS_BACKUP_ENDPOINT` | Endpoint S3 Swiss Backup (`https://…`) |
| `SWISS_BACKUP_REGION` | Région indiquée par Swiss Backup (vide sinon) |
| `SWISS_BACKUP_BUCKET` | `onconic-backups` |
| `BACKUP_AGE_PUBLIC_KEY` | Clé publique `age1…` |

### 5. Premier lancement

Actions > Sauvegarde nocturne > Run workflow. Le journal doit finir par le nombre d'archives quotidiennes. GitHub envoie un e-mail au propriétaire du dépôt si une exécution planifiée échoue.

GitHub désactive les workflows planifiés d'un dépôt public après 60 jours sans activité : un commit suffit à les réactiver.

## Restaurer

1. Télécharger l'archive depuis Swiss Backup avec Cyberduck : activer le profil **S3 (Deprecated path style requests)** (Réglages > Profils), puis connexion de ce type sur `s3.swiss-backup02.infomaniak.com`, port 443, clés Swiss Backup ; dossier `onconic-backups/quotidien`. Le profil « Amazon S3 » par défaut affiche les compartiments mais échoue sur leur contenu. Alternative : `rclone`.
2. Déchiffrer : `age -d -i onconic-backup.key onconic-AAAA-MM-JJ.tar.gz.age | tar -xzf -`
3. Le projet cible doit avoir `pg_cron` et `pg_net` activés (Database > Extensions). Retirer du fichier de données les tables réservées à Supabase, où le rôle `postgres` ne peut pas écrire (`storage.buckets_vectors`, `storage.vector_indexes`, `cron.job`) :

   ```sh
   awk '/^COPY "storage"\."(buckets_vectors|vector_indexes)" |^COPY "cron"\."job" /{skip=1;next} skip{if($0=="\\.")skip=0;next} /setval\(.*"cron"\./{next} {print}' db/data.sql > db/data-filtre.sql
   ```

4. Dans le projet **de test** d'abord (jamais directement en production), vérifier que l'adresse contient bien l'identifiant du projet de test, puis :

   ```sh
   psql --single-transaction --variable ON_ERROR_STOP=1 \
     --file db/roles.sql --file db/schema.sql \
     --command 'SET session_replication_role = replica' \
     --file db/data-filtre.sql --file db/extras.sql --file db/acl.sql \
     --dbname "$URL_PROJET_TEST"
   ```

   Contenu : `data.sql` inclut les comptes (`auth.users`, identités) et les métadonnées des fichiers (`storage.objects`). `extras.sql` recrée ce que `supabase db dump` ignore : les déclencheurs sur `auth.users` (création du profil à l'inscription, changement d'e-mail) et les règles d'accès de `storage.objects`. `acl.sql` rétablit les droits exacts de la production sur les tables et fonctions du schéma `public` : un projet Supabase neuf accorde par défaut **tous** les droits à `anon` et `authenticated`, et `schema.sql` ne les retire pas (constat du 13.11.2026 : 336 droits de table et 165 fonctions ouvertes aux visiteurs au lieu de 15 et 11). Ne jamais ouvrir une base restaurée sans avoir rejoué `acl.sql`. `cron.sql` contient les tâches planifiées : **ne le rejouer qu'en production**, jamais dans le projet de test (envois d'e-mails). Archives antérieures au 13.11.2026 (fin de journée) : pas de `extras.sql` ni de `cron.sql`, les recréer à partir de la production.
5. Fichiers Storage : `rclone copy storage/ <remote du projet cible>:`
6. Redéposer les secrets Edge et Vault depuis le gestionnaire de mots de passe.

Tester une restauration complète dans le projet de test avant l'annonce, puis chaque trimestre. Noter la date du dernier test ici :

- Premier envoi réussi : 13.11.2026 (archive de 6,7 Mo, base complète et 3 fichiers Storage).
- Test de déchiffrement avec la clé du gestionnaire de mots de passe : réussi le 13.11.2026.
- Restauration complète dans le projet de test `uubowlcyekbgmizrlyxb` : réussie le 13.11.2026. Comptes, profils, absences, fiches Key trials, contacts, références Storage, tables, fonctions et règles RLS identiques à la production. Deux écarts corrigés à cette occasion : tables réservées Supabase à filtrer, déclencheurs `auth` et règles `storage` absents du dump (désormais dans `extras.sql`).
- Droits : la restauration du 13.11.2026 avait laissé les droits par défaut de Supabase (trop larges) ; corrigé le jour même dans le projet de test et ajout de `acl.sql` à la sauvegarde nocturne.
- Prochain test de restauration : février 2027.
