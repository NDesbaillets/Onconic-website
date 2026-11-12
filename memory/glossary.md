# Glossaire Onconic

| Terme | Sens |
|------|------|
| Onconic | Site de l'équipe d'oncologie (onconic.ch), « Oncology made iconic » |
| The Hive | Espace membres ; s'appelait « La Ruche » (renommé le 30.10.2026, FR et EN) |
| alvéole | Tuile/outil du tableau de bord de The Hive |
| colonie | Ancien terme pour la communauté (retiré de la page d'accueil, remplacé par « ruche ») |
| Ultragenda | Agenda CHUV ; l'outil « Durée » lit l'Excel exporté (privé) |
| Durée | App secrétariat : temps à réserver par protocole (réservée aux membres CHUV) |
| Lettres | App médecins : lettres types de demande de garantie de prise en charge |
| Congrès | App « Congrès & formations — Qui d'autre butine au congrès ? » |
| Key trials | App des études clés, fiches en brouillon puis publiées par l'admin |
| km | Champ JSON des courbes de survie d'une fiche Key trials |
| digitized | Courbe relevée sur la figure publiée (vs reconstruite depuis médianes/taux) |
| seeded_at | Horodatage du dernier passage de `trials.sql` ; protège les fiches modifiées à la main |
| Neuro-oncologie | Remplace « Neurologie » partout (base comprise) |
| Blocs | Regroupement des cliniques : Bloc 1 (Sénologie, Gynécologie, Urologie), Bloc 2 (Thoracique, Neuro-oncologie, Mélanome), Bloc 3 (Lower GI, Upper GI, ORL, Sarcomes, Rad-Inter) ; ION et UTOH sont des blocs à part entière (un bloc, une clinique) ; l'outil Absences ajoute Plateforme et Administration |
| clinician / assistant / admin | Rôles validés ; « member » = compte en attente |
| nurse | Rôle infirmier·ère (12.11.2026) : accès par défaut à Durée (planification des traitements), Key trials, Formation, Annuaire prestataires et Annuaire pour médecins ; Durée et les annuaires exigent l'institution CHUV ; aucun autre outil sauf exception posée par l'admin |
| pharmacist | Rôle pharmacien (01.11.2026) : accès médecin + assistante ; admin des outils Lettres d'assurance, Limitations LS, Durée de traitement via `public.is_app_admin()` ; peut recevoir l'accès « médecin plus » ; invitation « Inviter comme pharmacien·ne » dans l'e-mail de demande d'adhésion |
