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
| **fonctions d'assistante** | Cochées dans Membres et accès sur le rôle assistant : « Cadre administratif » (planning, comptes temporaires), « Gestion des agendas médecins » (cliniques gérées, blocage Ultragenda), « Secrétaire de médecin cadre » (cadres attribués : voit et demande leurs absences, gère leur blocage Ultragenda) |
| **cliniques** | 15 cliniques de référence, dont **GI tube** (œsophage, estomac/JOG, colorectal, canal anal, GIST, TNE non pancréatiques) et **GI solide** (pancréas, voies biliaires, CHC), ION, UTOH, Hématologie et Tournus / Autre ; plus Plateforme et Administration dans Absences |
→ Glossaire complet : memory/glossary.md

## Projets actifs (détails : memory/projects/)
| Nom | État et suite |
|-----|------|
| **Absences** | En production (circuit configurable, lecture pour les cadres, « Mon circuit », diffusion PDF, blocage Ultragenda, suivi de la direction, PDF à tout moment, cheffe de service sur décision). À faire : désigner la cheffe de service dans le circuit, créer les blocs, cocher les fonctions des assistantes, prévenir les assistantes des absences « à bloquer » |
| **Key trials** | Brouillons à relire, rôle CDC par clinique, 10 fiches/jour |
| **Lettres d'assurance** | 31 lettres (thoracique) ; 2 Word à corriger |
| **Lettres médicales** | Accès « médecin plus », Haiku via `medical-letter` ; mise en service à finaliser |
| **Limitations LS** | LS à importer, 48 textes à valider ; pathologies Hématologie et Tournus / Autre à décider |
| **Congrès**, **Notifications congrès**, **Congrès plus** | En ligne ; veille mensuelle ; SQL et fonctions des deux extensions à déployer avant fusion |
| **Oncoodle** | En production (`202611130002`, `notify-oncoodle`) |
| **Planning administratif** | En production (17.11.2026) ; import du tableur réel à faire |
| **Administration** | `/admin/membres.html`, `/admin/review.html` : rôles, outils, fonctions d'assistante, invitations |
| **Annuaires**, **Formation**, **CTCAE v5/v6** | Outils en place ; contenu neuro-oncologie et traduction CTCAE à relire |
| **PWA** | Branche en relecture |
| **Infrastructure** | Suite : migration de sécurité, audit avant l'annonce, nLPD |

## Environnements
| | Production | Test |
|---|---|---|
| Site | onconic.ch (GitHub Pages, branche `main`) | onconic.pages.dev et un aperçu par branche (Cloudflare Pages, accès restreint par Cloudflare Access) |
| Supabase | `icqrobnqvidusajburcu` (Pro, Zurich) | `uubowlcyekbgmizrlyxb` (même organisation, Zurich) |
| Données | réelles | fictives, comptes `@example.com` |

- `assets/js/config.js` choisit le projet selon l'adresse : seules `onconic.ch` et `www.onconic.ch` vont en production ; toute autre adresse va au test, avec un bandeau orange.
- Sauvegardes : quotidiennes Supabase (7 jours) et nocturne chiffrée vers Infomaniak Swiss Backup (workflow `.github/workflows/sauvegarde-nocturne.yml`, procédure de restauration dans `docs/sauvegardes.md`). Restauration complète testée le 13.11.2026 ; prochain test en février 2027.
- Aucun lien GitHub automatique entre le dépôt et Supabase : les migrations s'appliquent à la main, selon la règle ci-dessus. Une migration de plus de 25 Ko s'applique par lots transactionnels d'environ 22 Ko (commentaires retirés, coupure entre deux instructions hors `$$`), vérifiés d'abord en PGlite, deux fois de suite.
- Les fichiers `supabase/*.sql` sont des bases historiques à ne plus rejouer (ils contiennent par exemple les anciens noms Lower GI et Upper GI) ; seules les migrations de `supabase/migrations/` font foi. Dernière migration en production : `202611230002` (23.11.2026).

## Agents et sessions
- Agents du dépôt : `developpeur` (Sonnet), `developpeur-rapide` (Haiku), `relecteur-code` et `relecteur-securite` (Sonnet) (ici, `.claude/agents/`), `redacteur-clinique` et `verificateur-references` (dans onconic-content).
- **Génération du code par sous-agents** (décision du 17.11.2026) : la session chef conçoit et rédige un cahier des charges précis ; `developpeur` écrit le code et les tests (`developpeur-rapide` pour une petite modification mécanique) ; `relecteur-code` relit la justesse, `relecteur-securite` la sécurité. La session chef corrige par un nouvel appel au développeur, applique le SQL et merge.
- Seule la session chef d'orchestre merge une PR et exécute du SQL sur Supabase (projet de test d'emblée, production sur feu vert, voir Préférences de travail). Les sessions enfants ouvrent une PR et s'arrêtent ; les sous-agents commitent sur la branche indiquée, sans pousser, et la session chef pousse et ouvre la PR. Aucun sous-agent ne reçoit `execute_sql`.
- Avant tout merge, la session chef lance `relecteur-securite` ; tout point bloquant empêche la fusion.

## Règles de sécurité (ne jamais enfreindre)
- Jamais de données patients, jamais de clé `service_role`/secrète dans le dépôt (la clé publishable peut l'être).
- Jamais commiter : Excel Ultragenda (`*.xlsx`), PDF de protocoles CHUV, lettres d'assurance Word.
- Le dépôt est **public** : ce fichier et memory/ ne contiennent que du contexte de projet.
