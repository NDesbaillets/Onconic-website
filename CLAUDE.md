# Memory

## Me
Nicolas Desbaillets, médecin oncologue (chef de clinique, CHUV Lausanne). Porteur du site Onconic (onconic.ch). Débutant en développement web : il valide, Claude construit.

## Préférences de travail
- Réponses en **français**, directes, recommandation d'abord, sans flatterie ni tirets cadratins.
- Ton médical sobre ; la métaphore des abeilles reste présente mais discrète (décision du 31.10.2026).
- Chaque changement : branche `claude/quirky-tesla-kpblcm` repartie de `origin/main`, PR, tests, puis **Claude merge lui-même la PR** (autorisation permanente donnée le 31.10.2026 ; Nicolas ne merge plus). Merger seulement une PR testée, mergeable et sans commentaire en suspens.
- **SQL Supabase : Claude l'exécute d'emblée** via le MCP Supabase (`execute_sql`, projet `icqrobnqvidusajburcu`), sans demander à Nicolas de le coller (autorisation permanente du 31.10.2026). Tester d'abord en PGlite ; pour un long fichier, l'envoyer par morceaux cohérents (schéma, puis données) ; vérifier ensuite par une requête de contrôle. Ne pas lancer de requête destructive (drop, delete massif) sans accord explicite.
- Ordre habituel : merger la PR, exécuter le SQL associé, vérifier la base, puis faire un compte rendu court.
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

## Règles de sécurité (ne jamais enfreindre)
- Jamais de données patients, jamais de clé `service_role`/secrète dans le dépôt (la clé publishable peut l'être).
- Jamais commiter : Excel Ultragenda (`*.xlsx`), PDF de protocoles CHUV, lettres d'assurance Word.
- Le dépôt est **public** : ce fichier et memory/ ne contiennent que du contexte de projet.
