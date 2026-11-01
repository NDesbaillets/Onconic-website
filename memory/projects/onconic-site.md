# Site Onconic : historique et points ouverts

## Livré (PR mergées)
- #15 retrait de l'app d'initiation de traitement (tables `protocols`, `sl_*` laissées en base).
- #16-17 Lettres d'assurance (+ filtre clinique). #18 icône écran d'accueil.
- #19 Congrès ; #21 lot de 8 changements (page d'accueil, The Hive, groupes médecins/secrétariat, bouton retour, Neuro-oncologie, calendrier congrès, page À propos, accueil premier login).
- #22-24 Key trials (fiches, schémas/traitements, courbes digitalisées).
- #25 page d'accueil plus médicale, cercles bleu marine pour les étapes 1-4.

## En attente
- Relire et publier les 14 fiches Key trials.
- Recoller `supabase/templates/invite.html` dans Supabase.
- Noms et rôles des contributeurs pour la section équipe de la page À propos (`#team`).
- Tâche planifiée « Veille congrès Onconic (mensuelle) » (1er de chaque mois, 7h37 Zurich, fenêtre de 18 mois, créée le 01.11.2026) ; l'ancienne tâche trimestrielle est désactivée. Le connecteur Supabase ne peut pas être attaché par Claude : à ajouter dans l'interface des tâches planifiées, sinon la tâche ne rend qu'une requête SQL à coller.
- Lettres Word à corriger puis redéposer : titre de la lettre atezolizumab 1L ; Tafinlar® au lieu de Mekinist® dans dabrafenib-trametinib.
- Proposés non retenus pour l'instant : 2FA admin, page d'administration des membres.
