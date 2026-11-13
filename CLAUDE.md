# Memory

## Me
Nicolas Desbaillets, médecin oncologue (chef de clinique, CHUV Lausanne). Porteur du site Onconic (onconic.ch). Débutant en développement web : il valide, Claude construit.

## Préférences de travail
- Réponses en **français**, directes, recommandation d'abord, sans flatterie ni tirets cadratins.
- Ton médical sobre ; la métaphore des abeilles reste présente mais discrète (décision du 31.10.2026).
- Chaque changement : branche `claude/quirky-tesla-kpblcm` repartie de `origin/main`, PR, tests, relecture par l'agent `relecteur-securite`, puis **Claude merge lui-même la PR** (autorisation permanente du 31.10.2026). Merger seulement une PR testée, mergeable, sans point bloquant ni commentaire en suspens.
- **SQL et Edge Functions : d'abord le test, la production sur feu vert** (règle du 13.11.2026, remplace celle du 31.10.2026) :
  1. Chaque changement de schéma est un fichier numéroté `supabase/migrations/AAAAMMJJNNNN_nom.sql`, transactionnel et réexécutable, testé d'abord en PGlite.
  2. **Projet de test `uubowlcyekbgmizrlyxb`** : Claude applique d'emblée via le MCP Supabase (`execute_sql`), déploie les Edge Functions, puis vérifie par une requête de contrôle et les advisors.
  3. Nicolas valide sur l'aperçu Cloudflare de la PR (`*.onconic.pages.dev`).
  4. **Production `icqrobnqvidusajburcu`** : seulement après le **feu vert explicite de Nicolas dans la conversation, pour cette migration précise**, et une sauvegarde du jour (sauvegarde nocturne réussie ce jour-là, sinon lancement manuel du workflow « Sauvegarde nocturne »). Ensuite requête de contrôle, advisors, fusion de la PR, compte rendu court.
  - En production sans feu vert : lecture seule (contrôles, comptages, advisors). Jamais de requête destructive (drop, delete, truncate) sans accord explicite, ni en production ni dans le projet de test.
  - Le projet de test ne contient que des données fictives (`docs/environnement-test.md`). Ne jamais y copier de données réelles hors test de restauration ; ne jamais y recréer les tâches cron ni y déposer de secrets d'envoi.
- Dates européennes (JJ.MM.AAAA), unités métriques, CHF.

## Termes
| Terme | Sens |
|------|------|
| **Onconic** | Site FR/EN de l'équipe d'oncologie, GitHub Pages + Supabase |
| **The Hive** | Espace membres (ex « La Ruche »), tableau de bord d'« alvéoles » (outils) |
| **alvéole** | Une app/outil dans The Hive |
| **Ultragenda** | Agenda CHUV ; Excel des durées de traitement (privé, jamais commité) |
| **Key trials** | App des études clés (fiches, schéma, traitements, courbes KM) |
| **Lettres** | App des lettres types de garantie de prise en charge (assurances) |
| **Congrès** | App « Qui d'autre butine au congrès ? » |
| **LS** | Liste des spécialités de l'OFSP (limitations, codes d'indication) |
| **médecin plus** | Drapeau caché `profiles.med_plus` donnant accès aux Lettres médicales |
| **rôles** | Trois rôles de médecins : clinician (**médecin assistant**), cdc (CDC = chef de clinique : médecin + gestion des fiches Key trials de ses cliniques), cadre (**médecin cadre** : exactement les droits d'un CDC, plus la validation des absences, s'il est coché « validateur des absences » et désigné pour une clinique par l'admin). Puis admin, direction (« Admin de direction » : gère les membres, le calendrier commun et les deux annuaires, vise les absences en 2e ligne, voir memory/projects/absences.md), assistant (assistante médicale : sans Congrès, Absences ni Key trials par défaut depuis le 12.11.2026), nurse (infirmier·ère : Durée, Key trials, Formation et les deux annuaires seulement), pharmacist ; « member » = en attente de validation. Les codes de rôle en base ne changent pas, seuls les libellés |
| **pharmacist** | Droits médecin + assistante réunis, et administration de Lettres d'assurance, Limitations LS et Durée (`is_app_admin()`) |
→ Glossaire complet : memory/glossary.md

## Projets actifs
| Nom | État |
|-----|------|
| **Key trials** | Fiches toutes visibles, brouillons à relire ; rôle CDC par clinique ; signalement « à réviser » ; préparation de 10 fiches/jour (voir memory/projects/key-trials.md) |
| **Lettres d'assurance** | 31 lettres importées (thoracique) ; 2 Word à corriger |
| **Congrès** | En ligne ; veille mensuelle programmée sur 18 mois (connecteur Supabase à attacher) |
| **Lettres médicales** | Accès « médecin plus » caché, Haiku via Edge Function ; mise en service à finaliser |
| **Limitations LS** | Recherche des limitations et codes d'indication, ordonnances per os ; LS à importer, 48 textes à valider |
| **Absences** | En ligne (PR #63, 06.11.2026) : demandes (vacances, congrès, autre), planning mensuel avec agenda commun (fériés vaudois, vacances scolaires, événements), validation par tous les validateurs concernés (cadres désignés par clinique), envoi par lot après confirmation, e-mails, agenda iCal, refus supprimables, avertissement de chevauchement, export Word, proposition depuis Congrès (voir memory/projects/absences.md) ; SQL et fonction `notify-absence` déjà déployés ; à régler dans l'admin : rôles Cadre, cliniques des médecins, valideurs, vacances scolaires à confirmer |
| **Infrastructure** | Supabase Pro, sauvegarde nocturne chiffrée, projet de test et aperçus Cloudflare (13.11.2026) ; restent : migration de sécurité (advisors), double authentification des admins dans l'app, audit avant l'annonce, nLPD avec la direction et la protection des données du CHUV |
| **Administration** | `/admin/membres.html` : membres, rôles, accès par outil (`has_tool`, exceptions `tool_access`) |
| **Page d'accueil** | Ton médical, abeilles discrètes (PR #25-26) |
| **PWA** | Manifeste, service worker, page hors ligne, astuce iPhone (branche en relecture) |
| **Notifications congrès** | Web Push « un autre membre participe au même congrès » ; SQL et fonction à déployer avant fusion (voir memory/projects/notifications.md) |
| **Congrès plus** | Détail de présentation, retours de congrès, abonnement agenda (voir memory/projects/congres-plus.md) ; SQL et fonction à déployer avant fusion |
| **Annuaire prestataires** | Nouvel outil (médecins, assistantes, pharmaciens) : fiches, recherche, filtres, favoris, import/export Excel (voir memory/projects/annuaire.md) |
| **Annuaire pour médecins** | Nouvel outil (médecins, pharmaciens) : contacts internes CHUV (numéros complets, raccourcis à 5 chiffres) et externes, recherche libre (voir memory/projects/contacts.md) ; données hors dépôt |
| **Formation** | Recueils de présentations HTML ou PDF par clinique et pathologie, recherche en texte intégral ; dépôt réservé à l'admin ; premier contenu neuro-oncologie à venir (voir memory/projects/formation.md) |
| **CTCAE v5 et v6** | Nouvel outil (médecins) : recherche libre d'un symptôme ou d'une anomalie biologique, grades v5 et v6 côte à côte, anglais et français ; données statiques, traduction à relire (voir memory/projects/ctcae.md) |
→ Détails : memory/projects/

## Environnements
| | Production | Test |
|---|---|---|
| Site | onconic.ch (GitHub Pages, branche `main`) | onconic.pages.dev et un aperçu par branche (Cloudflare Pages, accès restreint par Cloudflare Access) |
| Supabase | `icqrobnqvidusajburcu` (Pro, Zurich) | `uubowlcyekbgmizrlyxb` (même organisation, Zurich) |
| Données | réelles | fictives, comptes `@example.com` |

- `assets/js/config.js` choisit le projet selon l'adresse : seules `onconic.ch` et `www.onconic.ch` vont en production ; toute autre adresse va au test, avec un bandeau orange.
- Sauvegardes : quotidiennes Supabase (7 jours) et nocturne chiffrée vers Infomaniak Swiss Backup (workflow `.github/workflows/sauvegarde-nocturne.yml`, procédure de restauration dans `docs/sauvegardes.md`). Restauration complète testée le 13.11.2026 ; prochain test en février 2027.
- Aucun lien GitHub automatique entre le dépôt et Supabase : les migrations s'appliquent à la main, selon la règle ci-dessus.

## Agents et sessions
- Agents du dépôt : `relecteur-securite` (ici, `.claude/agents/`), `redacteur-clinique` et `verificateur-references` (dans onconic-content).
- Seule la session chef d'orchestre merge une PR et exécute du SQL sur Supabase. Les sessions enfants et les sous-agents ouvrent une PR et s'arrêtent. Aucun sous-agent ne reçoit `execute_sql`.
- Avant tout merge, la session chef lance `relecteur-securite` ; tout point bloquant empêche la fusion.

## Règles de sécurité (ne jamais enfreindre)
- Jamais de données patients, jamais de clé `service_role`/secrète dans le dépôt (la clé publishable peut l'être).
- Jamais commiter : Excel Ultragenda (`*.xlsx`), PDF de protocoles CHUV, lettres d'assurance Word.
- Le dépôt est **public** : ce fichier et memory/ ne contiennent que du contexte de projet.
