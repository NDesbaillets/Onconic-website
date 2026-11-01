# Lettres médicales (accès « médecin plus »)

**Page :** `/app/lettres-medicales.html` · **JS :** `assets/js/medletters.js` · **SQL :** `supabase/medletters.sql` · **Edge Function :** `supabase/functions/medical-letter`

## Principe (décisions du 01.11.2026)
- Accès caché : drapeau `profiles.med_plus` (non modifiable par l'utilisateur), attribué par un admin dans la page elle-même (section « Accès médecin plus »). Tuile The Hive retirée du DOM pour les autres membres.
- Génération par Claude Haiku 5.5 (`claude-haiku-5-5`) via l'Edge Function ; clé `ANTHROPIC_API_KEY` en secret Supabase, jamais dans le dépôt.
- Économie de tokens : thinking désactivé, effort low, consignes système figées et mises en cache (cache_control), lettre type en second bloc caché ; résultats identiques mis en cache en mémoire côté navigateur ; index des lettres types fait une seule fois à l'import.
- Garde-fous : regex de données identifiantes (dates complètes, naissance, AVS, IPP, e-mail, téléphone, « Dr/Mme + Nom ») côté navigateur ET serveur ; sortie masquée « […] » si détection ; rien n'est stocké ni journalisé ; limite 40 appels/jour/médecin (`medletter_usage`).
- Lettres types : import Word par l'admin (mammoth, index proposé par Haiku puis vérifié) ; lettre de novo proposée comme modèle → brouillon, validation admin.

## Ajouts du 01.11.2026 (2e lot)
- Avertissement : outil non autorisé par le CHUV, utilisation sous la responsabilité de l'utilisateur ; case à cocher obligatoire avant chaque génération.
- Performance status ECOG (plus « OMS »). Champ séparé « Biomarqueurs et biologie moléculaire ».
- Listes cliquables d'histologies et de biomarqueurs par clinique : `assets/js/onco-vocab.js` (« … » = valeur à saisir, bloque la génération tant qu'il reste).
- Stade calculé depuis le TNM : `assets/js/tnm-stage.js` (poumon UICC/IASLC 9e éd. ; côlon-rectum, sein anatomique, mélanome cutané clinique/pathologique, rein, vessie AJCC 8e). Jamais d'écrasement d'une saisie manuelle ; pas de calcul pour ypTNM, x, FIGO, prostate, ORL, sarcomes, SNC. 73 cas testés.
- Paragraphe 5 « suivi » (§S) repris de la lettre type ; inclus dans les modèles proposés.
- Lien vers la fiche Key trials quand l'acronyme de l'étude figure dans l'attitude, l'étude de référence ou la lettre type.

## Statut (01.11.2026)
- Version de test à but de développement uniquement : cas fictifs seulement, aucune information réelle d'un patient existant (avertissement, case à cocher et mention dans le Word exporté).

## Mise en service (01.11.2026)
- Fait : SQL appliqué et vérifié, fonction `medical-letter` déployée (v1, verify_jwt), PR #29 mergée.
- Reste (Nicolas) : secret `ANTHROPIC_API_KEY` dans Supabase > Edge Functions > Secrets ; import des lettres types Word ; cocher les médecins plus.
- Toute modification de `supabase/functions/medical-letter/index.ts` doit être redéployée (MCP `deploy_edge_function`).
