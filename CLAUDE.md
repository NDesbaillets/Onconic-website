# Memory

## Me
Nicolas Desbaillets, médecin oncologue (chef de clinique, CHUV Lausanne). Porteur du site Onconic (onconic.ch). Débutant en développement web : il valide, Claude construit.

## Préférences de travail
- Réponses en **français**, directes, recommandation d'abord, sans flatterie ni tirets cadratins.
- Ton médical sobre ; la métaphore des abeilles reste présente mais discrète (décision du 31.10.2026).
- Chaque changement : branche `claude/quirky-tesla-kpblcm` repartie de `origin/main`, PR, puis il merge lui-même.
- Le SQL Supabase : il le colle dans le SQL Editor (fichiers longs) ; Claude peut lire la base via MCP `execute_sql` (autorisé).
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
| **Congrès** | En ligne ; veille trimestrielle programmée (connecteur Supabase à attacher) |
| **Page d'accueil** | PR #26 (retour léger des abeilles) en attente de merge |
→ Détails : memory/projects/

## Règles de sécurité (ne jamais enfreindre)
- Jamais de données patients, jamais de clé `service_role`/secrète dans le dépôt (la clé publishable peut l'être).
- Jamais commiter : Excel Ultragenda (`*.xlsx`), PDF de protocoles CHUV, lettres d'assurance Word.
- Le dépôt est **public** : ce fichier et memory/ ne contiennent que du contexte de projet.
