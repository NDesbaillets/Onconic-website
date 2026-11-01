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
| **rôles** | admin, clinician, assistant ; « member » = en attente de validation |
→ Glossaire complet : memory/glossary.md

## Projets actifs
| Nom | État |
|-----|------|
| **Key trials** | 14 fiches thoraciques en brouillon, courbes digitalisées ; à relire/publier |
| **Lettres d'assurance** | 31 lettres importées (thoracique) ; 2 Word à corriger |
| **Congrès** | En ligne ; veille mensuelle programmée sur 18 mois (connecteur Supabase à attacher) |
| **Page d'accueil** | Ton médical, abeilles discrètes (PR #25-26) |
→ Détails : memory/projects/

## Règles de sécurité (ne jamais enfreindre)
- Jamais de données patients, jamais de clé `service_role`/secrète dans le dépôt (la clé publishable peut l'être).
- Jamais commiter : Excel Ultragenda (`*.xlsx`), PDF de protocoles CHUV, lettres d'assurance Word.
- Le dépôt est **public** : ce fichier et memory/ ne contiennent que du contexte de projet.
