# Lettres médicales (accès « médecin plus »)

**Page :** `/app/lettres-medicales.html` · **JS :** `assets/js/medletters.js` · **SQL :** `supabase/medletters.sql` · **Edge Function :** `supabase/functions/medical-letter`

## Principe (décisions du 01.11.2026)
- Accès caché : drapeau `profiles.med_plus` (non modifiable par l'utilisateur), attribué par un admin dans la page elle-même (section « Accès médecin plus »). Tuile The Hive retirée du DOM pour les autres membres.
- Génération par Claude Haiku 5.5 (`claude-haiku-5-5`) via l'Edge Function ; clé `ANTHROPIC_API_KEY` en secret Supabase, jamais dans le dépôt.
- Économie de tokens : thinking désactivé, effort low, consignes système figées et mises en cache (cache_control), lettre type en second bloc caché ; résultats identiques mis en cache en mémoire côté navigateur ; index des lettres types fait une seule fois à l'import.
- Garde-fous : regex de données identifiantes (dates complètes, naissance, AVS, IPP, e-mail, téléphone, « Dr/Mme + Nom ») côté navigateur ET serveur ; sortie masquée « […] » si détection ; rien n'est stocké ni journalisé ; limite 40 appels/jour/médecin (`medletter_usage`).
- Lettres types : import Word par l'admin (mammoth, index proposé par Haiku puis vérifié) ; lettre de novo proposée comme modèle → brouillon, validation admin.

## Mise en service (ordre impératif)
1. Exécuter `supabase/medletters.sql` AVANT de merger (auth.js lit `med_plus`).
2. Déployer la fonction `medical-letter` (verify_jwt true), créer le secret `ANTHROPIC_API_KEY`.
3. Merger la PR, importer les lettres types, cocher les médecins plus.
